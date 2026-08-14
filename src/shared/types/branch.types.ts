export interface Branch {
  id: string;
  name: string;
  slug: string;
  location: string;
  managerId: string | null;
  managerName: string | null;
  phone: string;
  address: string;
  city: string;
  isActive: boolean;
  dailyBudget?: number;
  weeklyBudget?: number;
  monthlyBudget?: number;
  /**
   * This branch's own cut for the company, 0-100.
   *
   * `null` means INHERIT the global `financeSettings.companySharePct` — not
   * zero. Resolve it with `resolveShareSplit()` (`@mb/shared/utils/share`)
   * rather than reading it directly, or a null reads as a 0% company share and
   * hands the branch the whole collection.
   */
  companySharePct?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateBranchPayload {
  name: string;
  location: string;
  phone: string;
  address: string;
  city: string;
  /** Omit or pass null to inherit the global split. */
  companySharePct?: number | null;
}

export interface UpdateBranchPayload {
  name?: string;
  location?: string;
  phone?: string;
  address?: string;
  city?: string;
  managerId?: string | null;
  isActive?: boolean;
  /** `null` clears the override and puts the branch back on the global split. */
  companySharePct?: number | null;
}
