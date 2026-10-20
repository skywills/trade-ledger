export const PROPOSAL_KINDS = [
  "manual_allocation",
  "identity_binding",
  "group_explicit",
  "lifecycle",
  "notes",
  "stop_loss",
  "group_merge",
  "import_exclusion",
  "import_inclusion",
  "lifecycle_attachment",
  "lifecycle_membership",
  "lifecycle_attachment_rejection",
  "wheel_campaign",
  "wheel_campaign_membership",
] as const;
export const UNSUPPORTED_PROPOSAL_KINDS = [
  "group_split",
  "lifecycle_valuation",
  "rejection",
] as const;
