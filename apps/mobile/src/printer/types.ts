import type {
  BusinessProfile,
  DataMode,
  PaymentMethod,
  Transaction,
} from "@/domain/types";

export interface ReceiptLine {
  name: string;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface ReceiptDocument {
  transactionId: string;
  revision: number;
  occurredAt: string;
  cashierName: string;
  paymentMethod: PaymentMethod;
  lines: ReceiptLine[];
  subtotal: number;
  total: number;
  paymentAmount: number;
  dataMode: DataMode;
  isCopy: boolean;
  receiptIdentity?: BusinessProfile;
}

export interface QrisPrintDocument {
  transactionId: string;
  paymentAmount: number;
  orderTotal: number;
  merchantName: string;
  merchantCity: string;
  payload: string;
  dataMode: DataMode;
}

export interface PrinterDevice {
  id: string;
  name: string;
  kind: "bluetooth" | "integrated" | "simulator";
}

export interface PrinterStatus {
  connected: boolean;
  ready: boolean;
  message: string;
}

export type PrinterResult =
  | { status: "success" }
  | { status: "failed"; message: string }
  | { status: "unknown"; message: string };

export interface ReceiptPrinter {
  readonly kind: PrinterDevice["kind"];
  discover(): Promise<PrinterDevice[]>;
  connect(deviceId?: string): Promise<void>;
  status(): Promise<PrinterStatus>;
  print(document: ReceiptDocument): Promise<PrinterResult>;
  printQris(document: QrisPrintDocument): Promise<PrinterResult>;
  disconnect(): Promise<void>;
}

export function receiptFromTransaction(
  transaction: Transaction,
  isCopy: boolean,
  dataMode: DataMode = "production",
): ReceiptDocument {
  return {
    transactionId: transaction.id,
    revision: transaction.revision,
    occurredAt: transaction.occurredAt,
    cashierName: transaction.updatedActorName,
    paymentMethod: transaction.paymentMethod,
    lines: transaction.items.map((item) => ({
      name: item.name,
      unitPrice: item.unitPrice,
      quantity: item.quantity,
      lineTotal: item.lineTotal,
    })),
    subtotal: transaction.subtotal,
    total: transaction.total,
    paymentAmount: transaction.paymentAmount,
    dataMode,
    isCopy,
    ...(transaction.receiptIdentity
      ? { receiptIdentity: { ...transaction.receiptIdentity } }
      : {}),
  };
}
