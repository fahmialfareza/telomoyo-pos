import type { SQLiteDatabase } from "expo-sqlite";
import { waitFor } from "@testing-library/react-native";

import { runLocalTransaction } from "@/db/transaction";

function fakeDatabase() {
  let active = false;
  const commands: string[] = [];
  const database = {
    isInTransactionSync: () => active,
    execAsync: async (command: string) => {
      commands.push(command);
      if (command === "BEGIN IMMEDIATE") {
        if (active)
          throw new Error("cannot start a transaction within a transaction");
        active = true;
      } else if (command === "COMMIT" || command === "ROLLBACK") {
        if (!active) throw new Error("no transaction is active");
        active = false;
      }
    },
  } as unknown as SQLiteDatabase;
  return { database, commands };
}

it("serializes overlapping local and sync transactions on one database", async () => {
  const { database, commands } = fakeDatabase();
  let finishFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const first = runLocalTransaction(database, async () => {
    commands.push("first work");
    await firstGate;
  });
  const second = runLocalTransaction(database, async () => {
    commands.push("second work");
  });
  await waitFor(() =>
    expect(commands).toEqual(["BEGIN IMMEDIATE", "first work"]),
  );
  finishFirst();
  await Promise.all([first, second]);
  expect(commands).toEqual([
    "BEGIN IMMEDIATE",
    "first work",
    "COMMIT",
    "BEGIN IMMEDIATE",
    "second work",
    "COMMIT",
  ]);
});

it("preserves the original failure and lets the next transaction proceed", async () => {
  const { database, commands } = fakeDatabase();
  const original = new Error("constraint failed: invalid package");
  await expect(
    runLocalTransaction(database, async () => {
      throw original;
    }),
  ).rejects.toBe(original);
  await runLocalTransaction(database, async () => {
    commands.push("recovered");
  });
  expect(commands).toEqual([
    "BEGIN IMMEDIATE",
    "ROLLBACK",
    "BEGIN IMMEDIATE",
    "recovered",
    "COMMIT",
  ]);
});

it("does not issue a misleading rollback after SQLite already ended the transaction", async () => {
  let active = false;
  const commands: string[] = [];
  const database = {
    isInTransactionSync: () => active,
    execAsync: async (command: string) => {
      commands.push(command);
      if (command === "BEGIN IMMEDIATE") active = true;
    },
  } as unknown as SQLiteDatabase;
  const original = new Error("underlying SQLite failure");
  await expect(
    runLocalTransaction(database, async () => {
      active = false;
      throw original;
    }),
  ).rejects.toBe(original);
  expect(commands).toEqual(["BEGIN IMMEDIATE"]);
});
