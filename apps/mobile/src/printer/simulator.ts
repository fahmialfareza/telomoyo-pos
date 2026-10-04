import type {
  PrinterDevice,
  PrinterResult,
  PrinterStatus,
  QrisPrintDocument,
  ReceiptDocument,
  ReceiptPrinter,
} from "./types";
import { formatQrisSlip, formatReceipt } from "./receipt";

export type SimulatorOutcome = "success" | "failed" | "unknown";

export class SimulatorPrinter implements ReceiptPrinter {
  readonly kind = "simulator" as const;
  private connected = false;
  private readonly outcome: SimulatorOutcome;
  private readonly columns: 32 | 48;
  lastOutput: string | null = null;

  constructor(outcome: SimulatorOutcome = "success", columns: 32 | 48 = 32) {
    this.outcome = outcome;
    this.columns = columns;
  }

  async discover(): Promise<PrinterDevice[]> {
    return [{ id: "simulator", name: "Simulator printer", kind: this.kind }];
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async status(): Promise<PrinterStatus> {
    return {
      connected: this.connected,
      ready: this.connected,
      message: this.connected ? "Simulator siap" : "Belum tersambung",
    };
  }

  async print(document: ReceiptDocument): Promise<PrinterResult> {
    if (!this.connected) {
      return { status: "failed", message: "Simulator belum tersambung." };
    }
    this.lastOutput = formatReceipt(document, this.columns);
    if (this.outcome === "failed") {
      return { status: "failed", message: "Kegagalan simulator terencana." };
    }
    if (this.outcome === "unknown") {
      return {
        status: "unknown",
        message: "Aliran cetak terputus setelah sebagian data dikirim.",
      };
    }
    return { status: "success" };
  }

  async printQris(document: QrisPrintDocument): Promise<PrinterResult> {
    if (!this.connected) {
      return { status: "failed", message: "Simulator belum tersambung." };
    }
    this.lastOutput = formatQrisSlip(document, this.columns);
    if (this.outcome === "failed") {
      return { status: "failed", message: "Kegagalan simulator terencana." };
    }
    if (this.outcome === "unknown") {
      return {
        status: "unknown",
        message: "Simulasi QRIS belum dapat dipastikan.",
      };
    }
    return { status: "success" };
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }
}
