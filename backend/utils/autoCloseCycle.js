/**
 * Auto-close billing cycle when all paying members have fully paid.
 *
 * After every completed payment, call `checkAndAutoCloseCycle` with the
 * roomId. It will:
 *   1. Find the active billing cycle for the room
 *   2. Enrich it (to get member_charges)
 *   3. Fetch all completed payments for that cycle
 *   4. Determine if every payer has all bill types (or a "total" payment)
 *   5. If yes → update cycle status to "closed"
 */
const SupabaseService = require("../db/SupabaseService");
const { enrichBillingCycle } = require("./enrichBillingCycle");

/**
 * Check whether all paying members have fully paid the active billing cycle.
 * If so, automatically close the cycle.
 *
 * @param {string} roomId - Room UUID
 * @returns {{ closed: boolean, cycleId?: string }} Result
 */
async function checkAndAutoCloseCycle(roomId) {
  try {
    // 1. Get active billing cycle
    const cycles = await SupabaseService.getRoomBillingCycles(roomId);
    const activeCycle = cycles.find((c) => c.status === "active");
    if (!activeCycle) return { closed: false, reason: "no_active_cycle" };

    // 2. Enrich to get member_charges
    const members = await SupabaseService.getRoomMembers(roomId);
    await enrichBillingCycle(activeCycle, members);

    const payingMembers = members.filter((m) => m.is_payer !== false);
    if (payingMembers.length === 0)
      return { closed: false, reason: "no_paying_members" };

    // 3. Get all completed payments for this cycle
    const payments =
      (await SupabaseService.getPaymentsForCycle(
        roomId,
        activeCycle.start_date,
        activeCycle.end_date,
      )) || [];

    const completedPayments = payments.filter(
      (p) => p.status === "completed" || p.status === "verified",
    );

    // 4. Check each payer - must have paid rent, electricity, water, internet, AND custom_charges if they exist
    let customCharges = [];
    if (activeCycle.custom_charges) {
      try {
        customCharges = Array.isArray(activeCycle.custom_charges)
          ? activeCycle.custom_charges
          : JSON.parse(activeCycle.custom_charges || "[]");
      } catch (_) {
        customCharges = [];
      }
    }

    const memberCustomChargesExist = (activeCycle.member_charges || []).some(
      (charge) =>
        charge.is_payer !== false &&
        (parseFloat(charge.custom_charges_share) || 0) > 0,
    );
    const customChargesExist =
      customCharges.length > 0 || memberCustomChargesExist;

    const allPaid = payingMembers.every((member) => {
      const memberPayments = completedPayments.filter(
        (p) => p.paid_by === member.user_id,
      );

      // A "total" payment covers everything (including custom charges)
      const hasTotalPayment = memberPayments.some(
        (p) => p.bill_type === "total",
      );
      if (hasTotalPayment) return true;

      // Otherwise need all four individual bill types
      const hasRent = memberPayments.some((p) => p.bill_type === "rent");
      const hasElectricity = memberPayments.some(
        (p) => p.bill_type === "electricity",
      );
      const hasWater = memberPayments.some((p) => p.bill_type === "water");
      const hasInternet = memberPayments.some(
        (p) => p.bill_type === "internet",
      );
      // CRITICAL: If custom charges exist, must also pay them
      const hasCustomCharges =
        !customChargesExist ||
        memberPayments.some((p) => p.bill_type === "custom_charges");

      return (
        hasRent && hasElectricity && hasWater && hasInternet && hasCustomCharges
      );
    });

    if (!allPaid) return { closed: false, reason: "not_all_paid" };

    // 5. Auto-close the cycle — snapshot member_charges so the completed
    //    cycle retains the exact per-member water split (presence-based).
    await SupabaseService.update("billing_cycles", activeCycle.id, {
      status: "completed",
      closed_at: new Date().toISOString(),
      member_charges: activeCycle.member_charges
        ? JSON.stringify(activeCycle.member_charges)
        : null,
    });

    console.log(
      `[AutoClose] Billing cycle ${activeCycle.id} auto-closed — all ${payingMembers.length} payors paid.`,
    );

    return { closed: true, cycleId: activeCycle.id };
  } catch (error) {
    // Don't let auto-close failures break the payment flow
    console.error("[AutoClose] Error checking auto-close:", error.message);
    return { closed: false, reason: "error", error: error.message };
  }
}

module.exports = { checkAndAutoCloseCycle };
