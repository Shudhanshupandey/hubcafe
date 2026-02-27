/**
 * Auto-Order Engine — Reusable core logic for executing auto orders.
 *
 * This module contains the pure business logic for auto-order execution,
 * completely decoupled from HTTP/route concerns. It can be called by:
 *   1. The Vercel Cron route handler (production)
 *   2. The manual test-execute endpoint (development)
 *   3. Any future scheduler or trigger
 *
 * DEBUG LOGGING: Every critical step is logged with [AutoOrder Engine] prefix.
 */

import { adminDb } from "@/lib/firebase-admin";
import { generateOrderId } from "@/lib/orderIdUtils";
import { FieldValue } from "firebase-admin/firestore";
import type { DayOfWeek } from "@/types";

// ─── Constants ──────────────────────────────────

const DAY_MAP: Record<number, DayOfWeek> = {
    0: "Sun", 1: "Mon", 2: "Tue", 3: "Wed",
    4: "Thu", 5: "Fri", 6: "Sat",
};

const WEEKDAYS: DayOfWeek[] = ["Mon", "Tue", "Wed", "Thu", "Fri"];

// IST offset = UTC + 5:30
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// ─── IST Helpers ────────────────────────────────

/** Convert a Date to IST and return { time: "HH:MM", day: DayOfWeek, dateStr: "YYYY-MM-DD" } */
export function getIST(date: Date) {
    const ist = new Date(date.getTime() + IST_OFFSET_MS);
    const hh = ist.getUTCHours().toString().padStart(2, "0");
    const mm = ist.getUTCMinutes().toString().padStart(2, "0");
    const day = DAY_MAP[ist.getUTCDay()];
    const yyyy = ist.getUTCFullYear();
    const mo = (ist.getUTCMonth() + 1).toString().padStart(2, "0");
    const dd = ist.getUTCDate().toString().padStart(2, "0");
    return { time: `${hh}:${mm}`, day, dateStr: `${yyyy}-${mo}-${dd}` };
}

// ─── Result type ────────────────────────────────

export interface AutoOrderResult {
    success: boolean;
    time: string;
    day: DayOfWeek;
    date: string;
    candidates: number;
    skipped: number;
    processed: number;
    succeeded: number;
    failed: number;
    errors: string[];
    message?: string;
}

// ─── Main Engine Function ───────────────────────

/**
 * Execute all pending auto orders for the current IST minute.
 *
 * This is the core function — no HTTP, no auth, just business logic.
 * Can optionally override the time for testing.
 */
export async function executeAutoOrders(overrideTime?: string): Promise<AutoOrderResult> {
    const runId = Math.random().toString(36).substring(2, 8);
    console.log(`\n[AutoOrder Engine] ═══════════════════════════════════════`);
    console.log(`[AutoOrder Engine] 🚀 Starting execution (runId: ${runId})`);

    // 1. Verify Firebase Admin is ready
    try {
        console.log(`[AutoOrder Engine] 🔥 Checking Firebase Admin SDK...`);
        const testRef = adminDb.collection("_healthcheck");
        console.log(`[AutoOrder Engine] ✅ Firebase Admin SDK is initialized`);
    } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[AutoOrder Engine] ❌ Firebase Admin SDK FAILED: ${errMsg}`);
        return {
            success: false,
            time: "??:??",
            day: "Mon",
            date: "unknown",
            candidates: 0,
            skipped: 0,
            processed: 0,
            succeeded: 0,
            failed: 0,
            errors: [`Firebase Admin SDK init failed: ${errMsg}`],
            message: "Firebase Admin SDK is not working",
        };
    }

    // 2. Get current IST time
    const now = new Date();
    const ist = getIST(now);
    const queryTime = overrideTime || ist.time;

    console.log(`[AutoOrder Engine] 🕐 UTC time: ${now.toISOString()}`);
    console.log(`[AutoOrder Engine] 🕐 IST time: ${ist.time}, Day: ${ist.day}, Date: ${ist.dateStr}`);
    if (overrideTime) {
        console.log(`[AutoOrder Engine] ⚠️  Using OVERRIDE time: ${overrideTime} (instead of ${ist.time})`);
    }

    const errors: string[] = [];

    try {
        // 3. Query active auto orders matching current time
        console.log(`[AutoOrder Engine] 🔍 Querying autoOrders where status=="active" AND time=="${queryTime}"...`);

        const snapshot = await adminDb
            .collection("autoOrders")
            .where("status", "==", "active")
            .where("time", "==", queryTime)
            .get();

        console.log(`[AutoOrder Engine] 📊 Firestore query returned ${snapshot.size} document(s)`);

        if (snapshot.empty) {
            console.log(`[AutoOrder Engine] 📭 No active orders for ${queryTime} — nothing to do`);
            console.log(`[AutoOrder Engine] ═══════════════════════════════════════\n`);
            return {
                success: true,
                time: queryTime,
                day: ist.day,
                date: ist.dateStr,
                candidates: 0,
                skipped: 0,
                processed: 0,
                succeeded: 0,
                failed: 0,
                errors: [],
                message: `No active auto orders for ${queryTime} IST`,
            };
        }

        // Log each candidate
        snapshot.docs.forEach((doc, i) => {
            const d = doc.data();
            console.log(`[AutoOrder Engine]   Candidate #${i + 1}: id=${doc.id}, item="${d.itemName}", qty=${d.quantity}, freq=${d.frequency}, user=${d.userId}`);
        });

        let processed = 0;
        let succeeded = 0;
        let failed = 0;
        let skipped = 0;

        // 4. Process each auto order
        for (const autoOrderDoc of snapshot.docs) {
            const autoOrder = autoOrderDoc.data();
            const autoOrderId = autoOrderDoc.id;

            console.log(`\n[AutoOrder Engine] ── Processing: ${autoOrderId} ──`);
            console.log(`[AutoOrder Engine]    Item: ${autoOrder.itemName} x${autoOrder.quantity} @ ₹${autoOrder.itemPrice}`);
            console.log(`[AutoOrder Engine]    Frequency: ${autoOrder.frequency}, User: ${autoOrder.userId}`);

            try {
                // ─── Day-of-week check ───
                let shouldRun = false;
                if (autoOrder.frequency === "daily") {
                    shouldRun = true;
                    console.log(`[AutoOrder Engine]    📅 Frequency=daily → shouldRun=true`);
                } else if (autoOrder.frequency === "weekdays") {
                    shouldRun = WEEKDAYS.includes(ist.day);
                    console.log(`[AutoOrder Engine]    📅 Frequency=weekdays, today=${ist.day} → shouldRun=${shouldRun}`);
                } else if (autoOrder.frequency === "custom" && Array.isArray(autoOrder.customDays)) {
                    shouldRun = autoOrder.customDays.includes(ist.day);
                    console.log(`[AutoOrder Engine]    📅 Frequency=custom, days=${autoOrder.customDays.join(",")}, today=${ist.day} → shouldRun=${shouldRun}`);
                }

                if (!shouldRun) {
                    console.log(`[AutoOrder Engine]    ⏭ Skipped — not scheduled for ${ist.day}`);
                    skipped++;
                    continue;
                }

                // ─── Duplicate guard ───
                if (autoOrder.lastExecutedDate === ist.dateStr) {
                    console.log(`[AutoOrder Engine]    ⏭ Skipped — already ran today (${ist.dateStr})`);
                    skipped++;
                    continue;
                }

                processed++;
                const total = autoOrder.itemPrice * autoOrder.quantity;
                console.log(`[AutoOrder Engine]    💰 Total cost: ₹${total}`);

                // ─── Atomic transaction ───
                console.log(`[AutoOrder Engine]    🔄 Starting Firestore transaction...`);

                await adminDb.runTransaction(async (transaction) => {
                    // ══════════════════════════════════════
                    // READ PHASE — all reads MUST come first
                    // ══════════════════════════════════════

                    // 1. Read user document
                    const userRef = adminDb.collection("users").doc(autoOrder.userId);
                    const userDoc = await transaction.get(userRef);

                    if (!userDoc.exists) {
                        console.error(`[AutoOrder Engine]    ❌ User ${autoOrder.userId} not found in Firestore`);
                        throw new Error("USER_NOT_FOUND");
                    }

                    const userData = userDoc.data()!;
                    const walletBalance = userData.walletBalance ?? 0;
                    console.log(`[AutoOrder Engine]    👛 Wallet balance: ₹${walletBalance}`);

                    // 2. Read menu item document (for stock validation)
                    const menuItemRef = adminDb.collection("menuItems").doc(autoOrder.itemId);
                    const menuItemDoc = await transaction.get(menuItemRef);

                    if (!menuItemDoc.exists) {
                        console.error(`[AutoOrder Engine]    ❌ Menu item ${autoOrder.itemId} ("${autoOrder.itemName}") not found`);
                        throw new Error("ITEM_NOT_FOUND");
                    }

                    const menuItemData = menuItemDoc.data()!;
                    const currentStock = menuItemData.quantity ?? 0;
                    const isAvailable = menuItemData.available !== false;
                    console.log(`[AutoOrder Engine]    📦 Menu item "${menuItemData.name}": stock=${currentStock}, available=${isAvailable}`);

                    // ══════════════════════════════════════
                    // VALIDATION PHASE
                    // ══════════════════════════════════════

                    // 3. Check item availability
                    if (!isAvailable) {
                        console.log(`[AutoOrder Engine]    🚫 Item "${autoOrder.itemName}" is marked unavailable`);

                        const execRef = adminDb.collection("autoOrderExecutions").doc();
                        transaction.set(execRef, {
                            autoOrderId,
                            userId: autoOrder.userId,
                            success: false,
                            failureReason: `Item "${autoOrder.itemName}" is unavailable`,
                            executedAt: now.toISOString(),
                        });

                        transaction.update(autoOrderDoc.ref, {
                            lastExecutedDate: ist.dateStr,
                            lastExecutedAt: now.toISOString(),
                            lastFailedAt: now.toISOString(),
                            lastFailureReason: `Item "${autoOrder.itemName}" is currently unavailable`,
                            totalFailures: FieldValue.increment(1),
                            updatedAt: now.toISOString(),
                        });

                        throw new Error("ITEM_UNAVAILABLE");
                    }

                    // 4. Check stock quantity
                    if (currentStock < autoOrder.quantity) {
                        console.log(`[AutoOrder Engine]    📉 INSUFFICIENT STOCK: ${currentStock} available < ${autoOrder.quantity} needed`);

                        const execRef = adminDb.collection("autoOrderExecutions").doc();
                        transaction.set(execRef, {
                            autoOrderId,
                            userId: autoOrder.userId,
                            success: false,
                            failureReason: `Insufficient stock: ${currentStock} available, ${autoOrder.quantity} needed`,
                            executedAt: now.toISOString(),
                        });

                        transaction.update(autoOrderDoc.ref, {
                            lastExecutedDate: ist.dateStr,
                            lastExecutedAt: now.toISOString(),
                            lastFailedAt: now.toISOString(),
                            lastFailureReason: `Insufficient stock for "${autoOrder.itemName}" (${currentStock} left, ${autoOrder.quantity} needed)`,
                            totalFailures: FieldValue.increment(1),
                            updatedAt: now.toISOString(),
                        });

                        throw new Error("INSUFFICIENT_STOCK");
                    }

                    // 5. Check wallet balance
                    if (walletBalance < total) {
                        console.log(`[AutoOrder Engine]    💸 INSUFFICIENT BALANCE: ₹${walletBalance} < ₹${total}`);

                        const execRef = adminDb.collection("autoOrderExecutions").doc();
                        transaction.set(execRef, {
                            autoOrderId,
                            userId: autoOrder.userId,
                            success: false,
                            failureReason: `Insufficient balance: ₹${walletBalance} < ₹${total}`,
                            executedAt: now.toISOString(),
                        });

                        transaction.update(autoOrderDoc.ref, {
                            lastExecutedDate: ist.dateStr,
                            lastExecutedAt: now.toISOString(),
                            lastFailedAt: now.toISOString(),
                            lastFailureReason: `Insufficient balance (₹${walletBalance} available, ₹${total} needed)`,
                            totalFailures: FieldValue.increment(1),
                            updatedAt: now.toISOString(),
                        });

                        throw new Error("INSUFFICIENT_BALANCE");
                    }

                    // ══════════════════════════════════════
                    // WRITE PHASE — all writes after reads
                    // ══════════════════════════════════════

                    console.log(`[AutoOrder Engine]    ✅ All validations passed — executing writes...`);

                    const orderId = generateOrderId();
                    console.log(`[AutoOrder Engine]    📝 Generated order ID: ${orderId}`);

                    // W1. Deduct stock from menu item
                    const newStock = currentStock - autoOrder.quantity;
                    transaction.update(menuItemRef, {
                        quantity: newStock,
                        available: newStock > 0,
                        updatedAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    📦 Stock deducted: ${currentStock} → ${newStock} (available: ${newStock > 0})`);

                    // W2. Deduct wallet balance
                    transaction.update(userRef, {
                        walletBalance: FieldValue.increment(-total),
                    });
                    console.log(`[AutoOrder Engine]    💳 Wallet deduction: -₹${total} (₹${walletBalance} → ₹${walletBalance - total})`);

                    // W3. Create order document
                    const orderRef = adminDb.collection("orders").doc();
                    transaction.set(orderRef, {
                        orderId,
                        userId: autoOrder.userId,
                        userName: userData.name || "Auto Order",
                        userEmail: userData.email || "",
                        userRollNumber: userData.rollNumber || "",
                        items: [{
                            id: autoOrder.itemId,
                            name: autoOrder.itemName,
                            price: autoOrder.itemPrice,
                            quantity: autoOrder.quantity,
                        }],
                        total,
                        paymentMode: "Wallet",
                        status: "pending",
                        isAutoOrder: true,
                        autoOrderId,
                        createdAt: now.toISOString(),
                        updatedAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    📦 Order document created in "orders" collection`);

                    // W4. Create wallet transaction record
                    const txnRef = adminDb.collection("walletTransactions").doc();
                    transaction.set(txnRef, {
                        userId: autoOrder.userId,
                        type: "debit",
                        amount: total,
                        description: `Auto Order #${orderId} — ${autoOrder.itemName} x${autoOrder.quantity}`,
                        transactionId: txnRef.id,
                        createdAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    💵 Wallet transaction recorded`);

                    // W5. Create notification document
                    const notifRef = adminDb.collection("notifications").doc();
                    transaction.set(notifRef, {
                        userId: autoOrder.userId,
                        orderId,
                        type: "auto_order",
                        title: "Auto Order Placed ✅",
                        message: `${autoOrder.itemName} x${autoOrder.quantity} (₹${total}) placed automatically.`,
                        isRead: false,
                        createdAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    🔔 Notification created in "notifications" collection`);

                    // W6. Create execution log
                    const execRef = adminDb.collection("autoOrderExecutions").doc();
                    transaction.set(execRef, {
                        autoOrderId,
                        userId: autoOrder.userId,
                        orderId,
                        success: true,
                        amountDeducted: total,
                        stockBefore: currentStock,
                        stockAfter: newStock,
                        executedAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    📋 Execution log recorded`);

                    // W7. Update auto order tracking
                    transaction.update(autoOrderDoc.ref, {
                        lastExecutedDate: ist.dateStr,
                        lastExecutedAt: now.toISOString(),
                        totalExecutions: FieldValue.increment(1),
                        updatedAt: now.toISOString(),
                    });
                    console.log(`[AutoOrder Engine]    📊 Auto-order tracking updated`);
                });

                succeeded++;
                console.log(`[AutoOrder Engine]    🎉 SUCCESS — ${autoOrder.itemName} x${autoOrder.quantity} → ₹${total} for ${autoOrder.userId}`);

            } catch (err) {
                const errMsg = err instanceof Error ? err.message : "Unknown error";
                if (errMsg === "INSUFFICIENT_BALANCE") {
                    console.log(`[AutoOrder Engine]    💸 FAILED — insufficient wallet balance`);
                    errors.push(`${autoOrderId}: insufficient balance`);
                } else if (errMsg === "USER_NOT_FOUND") {
                    console.error(`[AutoOrder Engine]    ❌ FAILED — user ${autoOrder.userId} not found`);
                    errors.push(`${autoOrderId}: user not found`);
                } else if (errMsg === "ITEM_NOT_FOUND") {
                    console.error(`[AutoOrder Engine]    ❌ FAILED — menu item ${autoOrder.itemId} not found`);
                    errors.push(`${autoOrderId}: menu item not found`);
                } else if (errMsg === "ITEM_UNAVAILABLE") {
                    console.log(`[AutoOrder Engine]    🚫 FAILED — item "${autoOrder.itemName}" unavailable`);
                    errors.push(`${autoOrderId}: item unavailable`);
                } else if (errMsg === "INSUFFICIENT_STOCK") {
                    console.log(`[AutoOrder Engine]    📉 FAILED — insufficient stock for "${autoOrder.itemName}"`);
                    errors.push(`${autoOrderId}: insufficient stock`);
                } else {
                    console.error(`[AutoOrder Engine]    ❌ FAILED — ${errMsg}`);
                    errors.push(`${autoOrderId}: ${errMsg}`);
                }
                failed++;
            }
        }

        const result: AutoOrderResult = {
            success: true,
            time: queryTime,
            day: ist.day,
            date: ist.dateStr,
            candidates: snapshot.size,
            skipped,
            processed,
            succeeded,
            failed,
            errors,
        };

        console.log(`\n[AutoOrder Engine] ─── SUMMARY ───`);
        console.log(`[AutoOrder Engine] Time: ${queryTime} IST (${ist.day}) ${ist.dateStr}`);
        console.log(`[AutoOrder Engine] Candidates: ${snapshot.size}, Processed: ${processed}, Succeeded: ${succeeded}, Failed: ${failed}, Skipped: ${skipped}`);
        console.log(`[AutoOrder Engine] ═══════════════════════════════════════\n`);

        return result;

    } catch (error) {
        const msg = error instanceof Error ? error.message : "Execution failed";
        console.error(`[AutoOrder Engine] 💥 FATAL ERROR: ${msg}`);
        console.error(`[AutoOrder Engine] Stack:`, error);
        console.log(`[AutoOrder Engine] ═══════════════════════════════════════\n`);
        return {
            success: false,
            time: queryTime,
            day: ist.day,
            date: ist.dateStr,
            candidates: 0,
            skipped: 0,
            processed: 0,
            succeeded: 0,
            failed: 0,
            errors: [msg],
            message: msg,
        };
    }
}
