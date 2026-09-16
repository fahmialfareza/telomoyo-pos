import { bytesToBase64 } from "@/security/secure-store";

import { encodeEscPos } from "./receipt";
import { SewaPrinterNative } from "./native";
import type {
  PrinterDevice,
  PrinterResult,
  PrinterStatus,
  ReceiptDocument,
  ReceiptPrinter,
} from "./types";

// Full-bold jobs run the thermal head hotter and slower, and cheap SPP
// printers have tiny RX buffers (~128-512B). A single burst write overruns
// the buffer and the tail (everything after the title) is silently dropped —
// then an immediate socket close aborts whatever is left. Pace the job from
// JS so it works regardless of whether the native module was rebuilt: the
// bridge stays a dumb single-write pipe.
const BLUETOOTH_CHUNK_BYTES = 64;
const BLUETOOTH_CHUNK_GAP_MS = 50;
const BLUETOOTH_SETTLE_MS = 1500;

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function writeBluetoothPaced(bytes: Uint8Array): Promise<number> {
  let written = 0;
  for (let offset = 0; offset < bytes.length; offset += BLUETOOTH_CHUNK_BYTES) {
    const chunk = bytes.slice(offset, offset + BLUETOOTH_CHUNK_BYTES);
    written += await SewaPrinterNative.writeBluetooth(bytesToBase64(chunk));
    if (offset + BLUETOOTH_CHUNK_BYTES < bytes.length) {
      await sleep(BLUETOOTH_CHUNK_GAP_MS);
    }
  }
  // The printer keeps burning buffered lines after our last flush. Full-bold
  // output needs extra time; returning early lets the caller disconnect and
  // close the RFCOMM socket while the tail is still printing.
  await sleep(BLUETOOTH_SETTLE_MS);
  return written;
}

export class BluetoothEscPosPrinter implements ReceiptPrinter {
  readonly kind = "bluetooth" as const;

  constructor(private readonly columns: 32 | 48) {}

  async discover(): Promise<PrinterDevice[]> {
    const devices = await SewaPrinterNative.discoverBluetooth();
    return devices.map((device: { id: string; name: string }) => ({
      ...device,
      kind: this.kind,
    }));
  }

  async connect(deviceId?: string): Promise<void> {
    if (!deviceId) throw new Error("Pilih printer Bluetooth.");
    await SewaPrinterNative.connectBluetooth(deviceId);
  }

  status(): Promise<PrinterStatus> {
    return SewaPrinterNative.getBluetoothStatus();
  }

  async print(document: ReceiptDocument): Promise<PrinterResult> {
    const status = await this.status();
    if (!status.ready) return { status: "failed", message: status.message };
    const bytes = encodeEscPos(document, this.columns);
    try {
      const written = await writeBluetoothPaced(bytes);
      return written === bytes.length
        ? { status: "success" }
        : {
            status: "unknown",
            message:
              "Jumlah byte yang diterima printer tidak dapat dipastikan.",
          };
    } catch (error) {
      return {
        status: "unknown",
        message:
          error instanceof Error
            ? error.message
            : "Koneksi terputus saat mencetak.",
      };
    }
  }

  async disconnect(): Promise<void> {
    // Small guard so a racing disconnect cannot cut a just-flushed job. The
    // settle delay already lives in writeBluetoothPaced; this covers callers
    // that disconnect without printing.
    await sleep(300);
    await SewaPrinterNative.disconnectBluetooth();
  }
}

export class IntegratedVendorPrinter implements ReceiptPrinter {
  readonly kind = "integrated" as const;

  constructor(private readonly columns: 32 | 48) {}

  async discover(): Promise<PrinterDevice[]> {
    const status = await this.status();
    return status.ready
      ? [{ id: "integrated", name: "Printer MPOS", kind: this.kind }]
      : [];
  }

  async connect(): Promise<void> {
    const status = await this.status();
    if (!status.ready) throw new Error(status.message);
  }

  status(): Promise<PrinterStatus> {
    return SewaPrinterNative.getIntegratedPrinterStatus();
  }

  async print(document: ReceiptDocument): Promise<PrinterResult> {
    try {
      await SewaPrinterNative.printIntegrated(
        bytesToBase64(encodeEscPos(document, this.columns)),
      );
      return { status: "success" };
    } catch (error) {
      return {
        status: "failed",
        message:
          error instanceof Error
            ? error.message
            : "Printer terintegrasi gagal mencetak.",
      };
    }
  }

  async disconnect(): Promise<void> {}
}
