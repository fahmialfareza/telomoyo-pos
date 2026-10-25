export type Role = "admin" | "superadmin";
export type DataMode = "production" | "sandbox";
export type SandboxQrisPolicy = "fixed_1000" | "transaction_total";
export type ContextKind = "account" | "tenant" | "platform";
export const INITIAL_TENANT_ID = "00000000-0000-4000-8000-000000000200";
export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  status: "pending_setup" | "active" | "suspended";
  revision?: number;
}
export interface BusinessProfile {
  businessName: string;
  address: string | null;
  phone: string | null;
  revision: number;
}
export interface DataScope {
  tenantId?: string | null;
  dataMode: DataMode;
  dataSpaceId?: string | null;
  sandboxGeneration?: number | null;
}
export type LocalScope = DataMode | DataScope;
export type SyncState = "pending" | "synced" | "conflict" | "error";
export type PrintState =
  "pending" | "success" | "failed" | "unknown" | "needs-reprint";
export type SelectablePaymentMethod = "cash" | "qris";
export type PaymentMethod = SelectablePaymentMethod | "legacy";
export type PaymentStatus = "pending" | "success" | "failed";
export type QrisPayloadHash = string;

export const PRODUCTION_DATA_SPACE_ID = "00000000-0000-4000-8000-000000000100";

export interface UserSummary {
  id: string;
  fullName: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  membershipId?: string | null;
}

export interface Session {
  token: string;
  sessionId: string;
  user: UserSummary;
  establishedAt: string;
  dataMode: DataMode;
  dataSpaceId: string | null;
  sandboxGeneration: number | null;
  contextKind?: ContextKind;
  tenantId?: string | null;
  membershipId?: string | null;
  tenant?: TenantSummary | null;
  isPlatformAdmin?: boolean;
  /** Optional only for sessions persisted before protocol 3. */
  protocolVersion?: number;
  sandboxQrisPolicy?: SandboxQrisPolicy;
}

export interface RentalPackage {
  id: string;
  revision: number;
  name: string;
  description: string;
  unitPrice: number;
  accent: "standard" | "sunrise" | "primary";
  active: boolean;
  deletedAt: string | null;
}

export interface TransactionItem {
  id: string;
  packageId: string;
  packageRevision: number;
  name: string;
  description: string;
  accent: RentalPackage["accent"];
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface Transaction {
  id: string;
  revision: number;
  occurredAt: string;
  subtotal: number;
  total: number;
  paymentAmount: number;
  originActorId: string;
  originActorName: string;
  updatedActorName: string;
  terminalId: string;
  syncState: SyncState;
  printState: PrintState;
  paymentMethod: PaymentMethod;
  paymentStatus: PaymentStatus;
  paymentConfirmedRevision: number | null;
  qrisPayloadHash: QrisPayloadHash | null;
  deletedAt: string | null;
  items: TransactionItem[];
  receiptIdentity?: BusinessProfile | undefined;
}

export interface TransactionDraftLine {
  package: RentalPackage;
  quantity: number;
}

export interface SyncConflict {
  id: string;
  transactionId: string;
  localSnapshot: Transaction;
  serverSnapshot: Transaction;
  createdAt: string;
}

export interface DashboardStats {
  gross: number;
  actualQrisAmount: number;
  /** Cash collected (payment amount of paid cash transactions). */
  cashAmount: number;
  transactionCount: number;
  quantities: {
    name: string;
    quantity: number;
    accent: string;
    revenue: number;
  }[];
  buckets: number[];
}
