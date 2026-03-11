import React, { useEffect, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import { Bot, Eye, EyeOff, Loader2, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { checkFirstRun, login, register } from "@/lib/api";
import { useAuth } from "@/App";

export default function Login() {
  const { token, login: authLogin } = useAuth();
  const navigate = useNavigate();

  const [isFirstRun, setIsFirstRun] = useState<boolean | null>(null);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (token) {
      navigate({ to: "/" });
    }
  }, [token, navigate]);

  useEffect(() => {
    checkFirstRun()
      .then(({ firstRun }) => {
        setIsFirstRun(firstRun);
        if (firstRun) setMode("register");
      })
      .catch(() => {
        // Backend may not have the endpoint — default to login
        setIsFirstRun(false);
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (mode === "register" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    if (password.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      if (mode === "register") {
        await register(username, password);
      }
      await authLogin(username, password);
      navigate({ to: "/" });
    } catch (err: any) {
      const msg =
        err?.response?.data?.message ??
        err?.response?.data?.error ??
        (mode === "login"
          ? "Invalid username or password."
          : "Registration failed. Please try again.");
      setError(msg);
    } finally {
      setLoading(false);
    }
  };

  const isLoading = isFirstRun === null;

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-950 px-4">
      <div className="w-full max-w-sm space-y-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-3">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-600/20 border border-indigo-500/30">
            <Bot className="h-7 w-7 text-indigo-400" />
          </div>
          <div className="text-center">
            <h1 className="text-2xl font-bold text-white tracking-tight">myEA</h1>
            <p className="text-sm text-slate-500 mt-0.5">Personal AI Assistant</p>
          </div>
        </div>

        {/* Card */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/80 backdrop-blur p-8 shadow-xl">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 text-slate-500 animate-spin" />
            </div>
          ) : (
            <>
              <div className="mb-6">
                <h2 className="text-base font-semibold text-white">
                  {mode === "login" ? "Sign in to your account" : "Create admin account"}
                </h2>
                {isFirstRun && (
                  <p className="text-xs text-amber-400 mt-1.5 flex items-center gap-1.5">
                    <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                    First run detected — set up your admin credentials.
                  </p>
                )}
              </div>

              <form onSubmit={handleSubmit} className="space-y-4">
                {error && (
                  <div className="rounded-md bg-red-950 border border-red-800/60 px-4 py-3 flex items-start gap-2.5">
                    <AlertCircle className="h-4 w-4 text-red-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-red-300">{error}</p>
                  </div>
                )}

                <div className="space-y-1.5">
                  <Label htmlFor="username" className="text-slate-300">
                    Username
                  </Label>
                  <Input
                    id="username"
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                    autoComplete="username"
                    autoFocus
                    placeholder="admin"
                    className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-indigo-500"
                  />
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="password" className="text-slate-300">
                    Password
                  </Label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete={mode === "register" ? "new-password" : "current-password"}
                      placeholder="••••••••"
                      className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-indigo-500 pr-10"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 transition-colors"
                      tabIndex={-1}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4" />
                      ) : (
                        <Eye className="h-4 w-4" />
                      )}
                    </button>
                  </div>
                </div>

                {mode === "register" && (
                  <div className="space-y-1.5">
                    <Label htmlFor="confirmPassword" className="text-slate-300">
                      Confirm Password
                    </Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      autoComplete="new-password"
                      placeholder="••••••••"
                      className="bg-slate-800 border-slate-700 text-white placeholder:text-slate-500 focus-visible:ring-indigo-500"
                    />
                  </div>
                )}

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white h-10"
                >
                  {loading ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" />
                      {mode === "login" ? "Signing in…" : "Creating account…"}
                    </>
                  ) : mode === "login" ? (
                    "Sign in"
                  ) : (
                    "Create account"
                  )}
                </Button>
              </form>

              {!isFirstRun && (
                <div className="mt-4 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setMode((m) => (m === "login" ? "register" : "login"));
                      setError(null);
                    }}
                    className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    {mode === "login"
                      ? "Need to add a new user? Register"
                      : "Already have an account? Sign in"}
                  </button>
                </div>
              )}
            </>
          )}
        </div>

        <p className="text-center text-xs text-slate-600">
          myEA admin panel &mdash; local access only
        </p>
      </div>
    </div>
  );
}
