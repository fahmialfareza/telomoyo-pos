import { requireNativeModule } from "expo";

interface NativeDevice {
  id: string;
  name: string;
}

interface NativeStatus {
  connected: boolean;
  ready: boolean;
  message: string;
}

interface SewaPrinterNativeModule {
  discoverBluetooth(): Promise<NativeDevice[]>;
  connectBluetooth(address: string): Promise<void>;
  writeBluetooth(base64: string): Promise<number>;
  disconnectBluetooth(): Promise<void>;
  getBluetoothStatus(): Promise<NativeStatus>;
  getIntegratedPrinterStatus(): Promise<NativeStatus>;
  printIntegrated(base64: string): Promise<void>;
}

export const SewaPrinterNative =
  requireNativeModule<SewaPrinterNativeModule>("SewaPrinter");
