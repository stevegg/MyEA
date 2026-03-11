/**
 * myEA — Authentication Plugin
 *
 * Fastify plugin that registers:
 *   POST /auth/login    — verify credentials, return JWT
 *   POST /auth/register — first-run user creation (only when no users exist)
 *   GET  /auth/me       — return current user info from JWT
 *
 * Also decorates the Fastify instance with `authenticate` — a preHandler hook
 * that verifies the JWT and injects the user payload into `request.user`.
 */

import type { FastifyInstance, FastifyPluginAsync, FastifyRequest, FastifyReply } from "fastify";
import fp from "fastify-plugin";
import bcrypt from "bcryptjs";
import { eq, count } from "drizzle-orm";
import type { AppConfig, LoginRequest, LoginResponse } from "../types";
import type { DrizzleDB } from "../db";
import { users } from "../db/schema";

// ─────────────────────────────────────────────────────────────────────────────
// Type augmentation — teach Fastify about the `authenticate` decorator
// ─────────────────────────────────────────────────────────────────────────────

declare module "fastify" {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      id: string;
      username: string;
      role: "admin";
      isAdmin: boolean;
    };
    user: {
      id: string;
      username: string;
      role: "admin";
      isAdmin: boolean;
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// JWT payload shape
// ─────────────────────────────────────────────────────────────────────────────

interface JWTPayload {
  id: string;
  username: string;
  role: "admin";
  isAdmin: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plugin
// ─────────────────────────────────────────────────────────────────────────────

interface AuthPluginOptions {
  db: DrizzleDB;
  config: AppConfig;
}

const authPlugin: FastifyPluginAsync<AuthPluginOptions> = async (
  app: FastifyInstance,
  opts: AuthPluginOptions
) => {
  const { db, config } = opts;

  // ── authenticate decorator ─────────────────────────────────

  app.decorate(
    "authenticate",
    async function (request: FastifyRequest, reply: FastifyReply): Promise<void> {
      try {
        await request.jwtVerify();
      } catch {
        // Return a generic 401 — never expose JWT error internals to the client
        reply.status(401).send({ error: "Unauthorized" });
      }
    }
  );

  // ── POST /auth/login ───────────────────────────────────────

  app.post<{ Body: LoginRequest }>(
    "/auth/login",
    {
      config: {
        // Strict rate limit on login: max 10 attempts per minute per IP
        rateLimit: {
          max: 10,
          timeWindow: "1 minute",
          errorResponseBuilder: () => ({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Too many login attempts. Please try again in 1 minute.",
          }),
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 1, maxLength: 64 },
            password: { type: "string", minLength: 1, maxLength: 1024 },
          },
        },
        response: {
          200: {
            type: "object",
            properties: {
              token: { type: "string" },
              expiresIn: { type: "string" },
            },
          },
        },
      },
    },
    async (request, reply): Promise<LoginResponse> => {
      const { username, password } = request.body;

      // Look up user in DB first; fall back to config-based admin check
      const [dbUser] = await db
        .select()
        .from(users)
        .where(eq(users.username, username))
        .limit(1);

      let userId: string;
      let isAdmin: boolean;

      if (dbUser) {
        const valid = await bcrypt.compare(password, dbUser.passwordHash);
        if (!valid) {
          return reply.status(401).send({ error: "Invalid username or password" }) as never;
        }
        userId = dbUser.id;
        isAdmin = dbUser.isAdmin;

        // Update lastLoginAt
        await db
          .update(users)
          .set({ lastLoginAt: new Date() })
          .where(eq(users.id, dbUser.id));
      } else {
        // Fallback to env-configured admin (for fresh installs before register is called)
        if (username !== config.auth.adminUsername) {
          return reply.status(401).send({ error: "Invalid username or password" }) as never;
        }
        const valid = await bcrypt.compare(password, config.auth.adminPasswordHash);
        if (!valid) {
          return reply.status(401).send({ error: "Invalid username or password" }) as never;
        }
        userId = "env-admin";
        isAdmin = true;
      }

      const payload: JWTPayload = { id: userId, username, role: "admin", isAdmin };
      const token = app.jwt.sign(payload);

      request.log.info({ username }, "User logged in");

      return { token, expiresIn: config.auth.jwtExpiresIn };
    }
  );

  // ── POST /auth/register ────────────────────────────────────

  app.post<{ Body: { username: string; password: string; displayName?: string } }>(
    "/auth/register",
    {
      config: {
        // Tight rate limit on register — this endpoint is disabled after first user anyway
        rateLimit: {
          max: 5,
          timeWindow: "1 minute",
          errorResponseBuilder: () => ({
            statusCode: 429,
            error: "Too Many Requests",
            message: "Too many registration attempts.",
          }),
        },
      },
      schema: {
        body: {
          type: "object",
          required: ["username", "password"],
          additionalProperties: false,
          properties: {
            username: { type: "string", minLength: 3, maxLength: 64, pattern: "^[a-zA-Z0-9_-]+$" },
            password: { type: "string", minLength: 8, maxLength: 1024 },
            displayName: { type: "string", maxLength: 128 },
          },
        },
      },
    },
    async (request, reply) => {
      const { username, password, displayName } = request.body;

      // Only allow registration when no users exist (first-run setup)
      const [{ value: userCount }] = await db
        .select({ value: count() })
        .from(users);

      if (Number(userCount) > 0) {
        return reply.status(403).send({
          error: "Registration is closed. An admin user already exists.",
        });
      }

      // Hash password
      const passwordHash = await bcrypt.hash(password, 12);

      const [newUser] = await db
        .insert(users)
        .values({
          username,
          passwordHash,
          isAdmin: true,
          displayName: displayName ?? null,
        })
        .returning();

      request.log.info({ username, userId: newUser.id }, "First admin user registered");

      const payload: JWTPayload = {
        id: newUser.id,
        username: newUser.username,
        role: "admin",
        isAdmin: true,
      };
      const token = app.jwt.sign(payload);

      return reply.status(201).send({
        token,
        expiresIn: config.auth.jwtExpiresIn,
        user: {
          id: newUser.id,
          username: newUser.username,
          displayName: newUser.displayName,
          isAdmin: newUser.isAdmin,
          createdAt: newUser.createdAt.toISOString(),
        },
      });
    }
  );

  // ── GET /auth/me ───────────────────────────────────────────

  app.get(
    "/auth/me",
    { preHandler: [app.authenticate] },
    async (request, reply) => {
      const { id, username, isAdmin } = request.user;

      // Fetch from DB if it's a real user (not the env-admin fallback)
      if (id !== "env-admin") {
        const [dbUser] = await db
          .select({
            id: users.id,
            username: users.username,
            displayName: users.displayName,
            isAdmin: users.isAdmin,
            createdAt: users.createdAt,
            lastLoginAt: users.lastLoginAt,
          })
          .from(users)
          .where(eq(users.id, id))
          .limit(1);

        if (dbUser) {
          return reply.send({
            id: dbUser.id,
            username: dbUser.username,
            displayName: dbUser.displayName,
            isAdmin: dbUser.isAdmin,
            createdAt: dbUser.createdAt.toISOString(),
            lastLoginAt: dbUser.lastLoginAt?.toISOString() ?? null,
          });
        }
      }

      // Fallback for env-admin
      return reply.send({ id, username, isAdmin, displayName: null });
    }
  );
};

export default fp(authPlugin, {
  name: "auth",
  dependencies: ["@fastify/jwt"],
});
