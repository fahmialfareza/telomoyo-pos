package expo.modules.sewaprinter

import android.annotation.SuppressLint
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothSocket
import android.content.Context
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.UUID

class SewaPrinterModule : Module() {
  private var bluetoothSocket: BluetoothSocket? = null
  private val sppUuid: UUID =
    UUID.fromString("00001101-0000-1000-8000-00805F9B34FB")

  override fun definition() = ModuleDefinition {
    Name("SewaPrinter")

    AsyncFunction("discoverBluetooth") {
      bondedDevices()
    }

    AsyncFunction("connectBluetooth") { address: String ->
      connectBluetooth(address)
    }

    AsyncFunction("writeBluetooth") { payload: String ->
      val socket = bluetoothSocket
        ?: throw IllegalStateException("Printer Bluetooth belum tersambung")
      val bytes = Base64.decode(payload, Base64.DEFAULT)
      // Dumb pipe: the JS layer (adapters.ts) is the single pacing layer and
      // already chunks with gaps plus a settle delay before disconnect, so a
      // burst write + flush per call keeps printing at normal speed.
      val output = socket.outputStream
      output.write(bytes)
      output.flush()
      bytes.size
    }

    AsyncFunction("disconnectBluetooth") {
      // Small guard so a racing disconnect cannot cut a just-flushed job.
      try {
        Thread.sleep(300)
      } catch (_: InterruptedException) {
      }
      bluetoothSocket?.close()
      bluetoothSocket = null
    }

    AsyncFunction("getBluetoothStatus") {
      val connected = bluetoothSocket?.isConnected == true
      mapOf(
        "connected" to connected,
        "ready" to connected,
        "message" to if (connected) "Printer Bluetooth siap" else "Belum tersambung"
      )
    }

    AsyncFunction("getIntegratedPrinterStatus") {
      mapOf(
        "connected" to false,
        "ready" to false,
        "message" to "SDK printer MPOS belum dipasang"
      )
    }

    AsyncFunction<Unit, String>("printIntegrated") {
      throw IllegalStateException("VENDOR_SDK_NOT_CONFIGURED")
    }

    OnDestroy {
      bluetoothSocket?.close()
      bluetoothSocket = null
    }
  }

  @SuppressLint("MissingPermission")
  private fun bondedDevices(): List<Map<String, String>> {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Konteks Android belum tersedia")
    val manager =
      context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val adapter = manager.adapter ?: return emptyList()
    return adapter.bondedDevices
      .sortedBy { it.name ?: it.address }
      .map {
        mapOf(
          "id" to it.address,
          "name" to (it.name ?: "Printer ${it.address.takeLast(5)}")
        )
      }
  }

  @SuppressLint("MissingPermission")
  private fun connectBluetooth(address: String) {
    val context = appContext.reactContext
      ?: throw IllegalStateException("Konteks Android belum tersedia")
    val manager =
      context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
    val adapter = manager.adapter
      ?: throw IllegalStateException("Bluetooth tidak tersedia")
    adapter.cancelDiscovery()
    bluetoothSocket?.close()
    bluetoothSocket =
      adapter.getRemoteDevice(address)
        .createRfcommSocketToServiceRecord(sppUuid)
        .also { it.connect() }
  }
}
