// Defines auth profile configuration types.
export type AuthProfileConfig = {
  /** Provider id this auth profile can satisfy. */
  provider: string;
  /**
   * Auth route selected by this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   * - aws-sdk: AWS SDK default credential chain (no secret in auth-profiles.json)
   */
  mode: "api_key" | "aws-sdk" | "oauth" | "token";
  /** Optional account email shown in profile selection/status surfaces. */
  email?: string;
  /** Optional human-readable label shown in profile selection/status surfaces. */
  displayName?: string;
};

export type UsageThresholdRule = {
  /** Usage window label to match (for example "5h" or "1w"). */
  window: string;
  /** Trigger when remaining percentage is less than or equal to this value. */
  remainingPercentLte: number;
};

export type UsagePolicySurfaceConfig = {
  /** Show warning/decision details in `/status` style replies. Default: true. */
  status?: boolean;
  /** Show warning/decision details in `session_status`. Default: true. */
  sessionStatus?: boolean;
  /** Emit a preflight notice before a turn when a warn/switch decision applies. Default: false. */
  preflightNotice?: boolean;
};

export type UsagePolicyRules = {
  /** Warn when matching usage windows reach these remaining-percentage thresholds. */
  warn?: UsageThresholdRule[];
  /** Stop new turns when matching usage windows reach these remaining-percentage thresholds. */
  stop?: UsageThresholdRule[];
  /** Switch to another profile when matching usage windows reach these thresholds. */
  switch?: UsageThresholdRule[];
  /**
   * Keep manual `/profile` selections sticky unless explicitly disabled.
   * Default: true.
   */
  respectUserOverride?: boolean;
  /** Behavior when a switch rule matches but no eligible target profile exists. Default: warn. */
  onNoSwitchTarget?: "allow" | "warn" | "stop";
  /** Per-surface visibility toggles for usage-policy notices. */
  surfaces?: UsagePolicySurfaceConfig;
};

export type UsagePolicyConfig = {
  /** Enable cached usage-policy evaluation for supported providers. Default: false. */
  enabled?: boolean;
  /** Minimum refresh cadence, in minutes, for async usage snapshot updates. Default: 15. */
  refreshMinutes?: number;
  /** Treat cached usage snapshots older than this as stale. Default: 20. */
  staleAfterMinutes?: number;
  /** Decision to apply when cached usage data is stale. Default: allow. */
  staleBehavior?: "allow" | "warn" | "stop";
  /** Global fallback rules when no provider-specific or profile-specific rules exist. */
  defaults?: UsagePolicyRules;
  /** Provider-specific usage-policy rules keyed by provider id. */
  providers?: Record<string, UsagePolicyRules>;
  /** Profile-specific usage-policy rules keyed by auth profile id. */
  profiles?: Record<string, UsagePolicyRules>;
};

export type AuthConfig = {
  /** Named auth profiles keyed by profile id. */
  profiles?: Record<string, AuthProfileConfig>;
  /** Preferred profile order per provider id. */
  order?: Record<string, string[]>;
  /** Backoff and same-provider rotation policy for auth/profile failures. */
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */
    billingBackoffHours?: number;
    /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>;
    /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Base backoff for high-confidence permanent-auth failures (minutes).
     * Default: 10.
     */
    authPermanentBackoffMinutes?: number;
    /**
     * Cap for high-confidence permanent-auth backoff (minutes). Default: 60.
     */
    authPermanentMaxMinutes?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for overloaded
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    overloadedProfileRotations?: number;
    /**
     * Fixed delay before retrying an overloaded provider/profile rotation.
     * Default: 0.
     */
    overloadedBackoffMs?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for rate-limit
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    rateLimitedProfileRotations?: number;
  };
  usagePolicy?: UsagePolicyConfig;
};
