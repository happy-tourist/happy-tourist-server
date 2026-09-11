import { auth } from "@colyseus/auth";

/**
 * Register OAuth providers for @colyseus/auth.
 * Side-effect import from app.config.ts so providers exist before listen.
 * Built-in AuthService onOAuthProviderCallback is left untouched (D2).
 */
auth.oauth.addProvider("google", {
  key: process.env.GOOGLE_CLIENT_ID,
  secret: process.env.GOOGLE_CLIENT_SECRET,
  scope: ["email", "profile"],
});
