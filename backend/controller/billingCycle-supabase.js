// Billing Cycle Controller (Supabase Version)
const express = require("express");
const router = express.Router();
const SupabaseService = require("../db/SupabaseService");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAuthenticated, isAdminOrHost } = require("../middleware/auth");
const {
  enrichBillingCycle,
  enrichBillingCycles,
} = require("../utils/enrichBillingCycle");
const cache = require("../utils/MemoryCache");

// Helper to normalize a billing cycle charge for mobile compatibility
const normalizeCharge = (charge) => {
  if (!charge) return charge;
  return {
    ...charge,
    userId: charge.user_id,
    billingCycleId: charge.billing_cycle_id,
    isPayer: charge.is_payer,
    presenceDays: charge.presence_days,
    rentShare: charge.rent_share,
    electricityShare: charge.electricity_share,
    waterBillShare: charge.water_bill_share,
    waterOwn: charge.water_own,
    waterSharedNonpayor: charge.water_shared_nonpayor,
    internetShare: charge.internet_share,
    customChargesShare: charge.custom_charges_share,
    totalDue: charge.total_due,
  };
};

// Helper to normalize snake_case Supabase fields to camelCase for mobile clients
const normalizeBillingCycle = (cycle) => {
  if (!cycle) return cycle;

  // Parse member_charges if it's stored as JSON string (from closed cycles)
  let memberCharges = cycle.member_charges;
  if (typeof memberCharges === "string") {
    try {
      memberCharges = JSON.parse(memberCharges);
    } catch {
      memberCharges = [];
    }
  }

  // Parse custom_charges if present
  let customCharges = cycle.custom_charges;
  if (customCharges && typeof customCharges === "string") {
    try {
      customCharges = JSON.parse(customCharges);
    } catch {
      customCharges = [];
    }
  }

  return {
    ...cycle,
    startDate: cycle.start_date,
    endDate: cycle.end_date,
    waterBillAmount: cycle.water_bill_amount,
    totalBilledAmount: cycle.total_billed_amount,
    createdAt: cycle.created_at,
    createdBy: cycle.created_by,
    roomId: cycle.room_id,
    cycleNumber: cycle.cycle_number,
    previousMeterReading: cycle.previous_meter_reading ?? null,
    currentMeterReading: cycle.current_meter_reading ?? null,
    paymentGatewayOpen: cycle.payment_gateway_open === true,
    paymentGatewayOpenedAt: cycle.payment_gateway_opened_at ?? null,
    paymentGatewayOpenedBy: cycle.payment_gateway_opened_by ?? null,
    paymentGatewayClosedAt: cycle.payment_gateway_closed_at ?? null,
    paymentGatewayClosedBy: cycle.payment_gateway_closed_by ?? null,
    customCharges: customCharges || [],
    memberCharges: (memberCharges || []).map(normalizeCharge),
  };
};

// ============================================================
// HELPERS — server-side stats derived from live DB data
// ============================================================

/**
 * Fetch the room's current members and compute:
 *   membersCount    — number of approved members
 *   waterBillAmount — total water charge based on billing mode
 *
 * For "fixed_monthly" rooms the caller-supplied fixedWaterAmount is used
 * as-is.  For presence-based rooms the water is recomputed from actual
 * presence records stored in Supabase (₱5 / member presence-day).
 */
const computeCycleStats = async (
  roomId,
  startDate,
  endDate,
  fixedWaterAmount,
  waterBillingMode,
  waterFixedType = "by_room",
  perPersonRate = null,
) => {
  try {
    const members = (await SupabaseService.getRoomMembers(roomId)) || [];
    const approvedMembers = members.filter(
      (m) => !m.status || m.status === "approved",
    );
    const membersCount = approvedMembers.length;

    let waterBillAmount;
    if (waterBillingMode === "fixed_monthly" && Number(fixedWaterAmount) > 0) {
      if (waterFixedType === "per_person") {
        // Use the per-person rate from room settings, NOT the client-provided
        // total (which may already be pre-multiplied by the mobile app).
        // Multiply by ALL members (not just payers) — non-payer water is
        // redistributed to payers in enrichBillingCycle.
        const rate =
          perPersonRate != null
            ? Number(perPersonRate)
            : Number(fixedWaterAmount);
        waterBillAmount = Math.round(rate * membersCount * 100) / 100;
      } else {
        // By-room: amount is the total already
        waterBillAmount = Number(fixedWaterAmount);
      }
    } else {
      // Presence-based — recompute from DB presence records
      const sd = new Date(startDate);
      const ed = new Date(endDate);
      waterBillAmount = approvedMembers.reduce((total, member) => {
        const presence = Array.isArray(member.presence) ? member.presence : [];
        const days = presence.filter((dateStr) => {
          const d = new Date(dateStr);
          return d >= sd && d <= ed;
        }).length;
        // console.log(
        //   "[computeCycleStats]",
        //   member.name,
        //   "| presence count:",
        //   presence.length,
        //   "| days in range:",
        //   days,
        //   "| sd:",
        //   sd.toISOString(),
        //   "| ed:",
        //   ed.toISOString(),
        //   "| sample dates:",
        //   presence.slice(0, 3),
        // );
        return total + days * 5;
      }, 0);
      // console.log(
      //   "[computeCycleStats] Final waterBillAmount:",
      //   waterBillAmount,
      //   "| fixedWaterAmount:",
      //   fixedWaterAmount,
      // );
      // Fallback: if presence yields 0 but admin sent a value, keep it
      if (!waterBillAmount && Number(fixedWaterAmount) > 0) {
        waterBillAmount = Number(fixedWaterAmount);
      }
    }

    return { membersCount, waterBillAmount };
  } catch (_err) {
    return { membersCount: 0, waterBillAmount: Number(fixedWaterAmount) || 0 };
  }
};

// ============================================================
// CREATE A NEW BILLING CYCLE
// ============================================================
router.post("/", isAuthenticated, async (req, res, next) => {
  try {
    const {
      roomId,
      startDate,
      endDate,
      rent,
      electricity,
      previousMeterReading,
      currentMeterReading,
      water,
      waterBillAmount,
      internet,
      customCharges,
    } = req.body;

    // Validation
    if (!roomId || !startDate || !endDate) {
      return next(
        new ErrorHandler("Room ID, start date, and end date are required", 400),
      );
    }

    if (new Date(startDate) >= new Date(endDate)) {
      return next(new ErrorHandler("Start date must be before end date", 400));
    }

    const room = await SupabaseService.findRoomById(roomId);
    if (!room) {
      return next(new ErrorHandler("Room not found", 404));
    }

    // Get existing cycles for this room
    const existingCycles = await SupabaseService.getRoomBillingCycles(roomId);

    // Safety: If an active cycle already exists, update it instead of creating a duplicate
    const activeCycle = existingCycles?.find((c) => c.status === "active");
    if (activeCycle) {
      const updRent = rent || activeCycle.rent || 0;
      const updElec = electricity || activeCycle.electricity || 0;
      const updWaterRaw =
        waterBillAmount || water || activeCycle.water_bill_amount || 0;
      const updInternet = internet || activeCycle.internet || 0;

      // Calculate custom charges total
      const customChargesArray = Array.isArray(customCharges)
        ? customCharges
        : activeCycle.custom_charges
          ? typeof activeCycle.custom_charges === "string"
            ? JSON.parse(activeCycle.custom_charges)
            : activeCycle.custom_charges
          : [];
      const customChargesTotal = customChargesArray.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );

      // Recompute members_count and water from live DB data
      const { membersCount: updMembersCount, waterBillAmount: updWater } =
        await computeCycleStats(
          roomId,
          startDate,
          endDate,
          updWaterRaw,
          room.water_billing_mode,
          room.water_fixed_type,
          room.water_fixed_amount,
        );

      const updatePayload = {
        start_date: new Date(startDate),
        end_date: new Date(endDate),
        rent: updRent,
        electricity: updElec,
        water_bill_amount: updWater,
        internet: updInternet,
        members_count: updMembersCount,
        member_charges: null,
        total_billed_amount:
          parseFloat(updRent) +
          parseFloat(updElec) +
          parseFloat(updWater) +
          parseFloat(updInternet) +
          customChargesTotal,
      };
      // Update custom charges if provided, otherwise preserve existing
      if (customCharges && customCharges.length > 0) {
        updatePayload.custom_charges = JSON.stringify(customCharges);
      } else if (activeCycle.custom_charges) {
        updatePayload.custom_charges = activeCycle.custom_charges;
      }
      if (previousMeterReading != null)
        updatePayload.previous_meter_reading = previousMeterReading;
      else if (activeCycle.previous_meter_reading != null)
        updatePayload.previous_meter_reading =
          activeCycle.previous_meter_reading;
      if (currentMeterReading != null)
        updatePayload.current_meter_reading = currentMeterReading;
      else if (activeCycle.current_meter_reading != null)
        updatePayload.current_meter_reading = activeCycle.current_meter_reading;
      const updatedCycle = await SupabaseService.update(
        "billing_cycles",
        activeCycle.id,
        updatePayload,
      );

      return res.status(200).json({
        success: true,
        message: "Active billing cycle updated (already existed)",
        billingCycle: normalizeBillingCycle(updatedCycle),
      });
    }

    // Get next cycle number
    const cycleNumber = (existingCycles?.length || 0) + 1;

    // Create new billing cycle
    const rentVal = rent || 0;
    const elecVal = electricity || 0;
    const waterValRaw = waterBillAmount || water || 0;
    const internetVal = internet || 0;

    // Recompute members_count and water from live DB data
    const { membersCount: newMembersCount, waterBillAmount: waterVal } =
      await computeCycleStats(
        roomId,
        startDate,
        endDate,
        waterValRaw,
        room.water_billing_mode,
        room.water_fixed_type,
        room.water_fixed_amount,
      );

    // Calculate custom charges total
    const customChargesArray = Array.isArray(customCharges)
      ? customCharges
      : [];
    console.log("[BILLING-CREATE] Received customCharges:", customChargesArray);
    const customChargesTotal = customChargesArray.reduce(
      (sum, charge) => sum + parseFloat(charge.amount || 0),
      0,
    );

    const totalAmount =
      parseFloat(rentVal) +
      parseFloat(elecVal) +
      parseFloat(waterVal) +
      parseFloat(internetVal) +
      customChargesTotal;

    const billingCycle = await SupabaseService.createBillingCycle({
      room_id: roomId,
      cycle_number: cycleNumber,
      start_date: new Date(startDate),
      end_date: new Date(endDate),
      rent: rentVal,
      electricity: elecVal,
      water_bill_amount: waterVal,
      internet: internetVal,
      custom_charges:
        customChargesArray.length > 0
          ? JSON.stringify(customChargesArray)
          : null,
      members_count: newMembersCount,
      previous_meter_reading:
        previousMeterReading != null ? previousMeterReading : null,
      current_meter_reading:
        currentMeterReading != null ? currentMeterReading : null,
      total_billed_amount: totalAmount,
      status: "active",
      payment_gateway_open: false,
      created_by: req.user.id,
    });

    console.log(
      "[BILLING-CREATE] Created cycle custom_charges:",
      billingCycle?.custom_charges,
    );

    // Auto-create a pinned announcement banner for all room members
    try {
      const fmt = (d) =>
        new Date(d).toLocaleDateString("en-PH", {
          month: "short",
          day: "numeric",
          year: "numeric",
        });
      const lines = [`📅 Period: ${fmt(startDate)} – ${fmt(endDate)}`];
      if (parseFloat(rentVal) > 0)
        lines.push(`🏠 Rent: ₱${parseFloat(rentVal).toFixed(2)}`);
      if (parseFloat(elecVal) > 0)
        lines.push(`⚡ Electricity: ₱${parseFloat(elecVal).toFixed(2)}`);
      if (parseFloat(waterVal) > 0)
        lines.push(`💧 Water: ₱${parseFloat(waterVal).toFixed(2)}`);
      if (parseFloat(internetVal) > 0)
        lines.push(`📶 Internet: ₱${parseFloat(internetVal).toFixed(2)}`);
      // Add custom charges to announcement if present
      customChargesArray.forEach((charge) => {
        if (parseFloat(charge.amount) > 0) {
          lines.push(
            `📌 ${charge.name}: ₱${parseFloat(charge.amount).toFixed(2)}`,
          );
        }
      });
      lines.push(`\n💰 Total: ₱${totalAmount.toFixed(2)}`);

      // Unpin any existing pinned cycle announcements first
      const existing = await SupabaseService.selectAll(
        "announcements",
        "room_id",
        roomId,
      );
      const prevPinned = (existing || []).filter(
        (a) => a.is_pinned && a.notification_type === "billing_cycle",
      );
      await Promise.all(
        prevPinned.map((a) =>
          SupabaseService.update("announcements", a.id, { is_pinned: false }),
        ),
      );

      await SupabaseService.insert("announcements", {
        room_id: roomId,
        title: `New Billing Cycle #${cycleNumber} – ${room.name || "Your Room"}`,
        content: lines.join("\n"),
        created_by: req.user.id,
        is_pinned: true,
        target_user_id: null,
        notification_type: "billing_cycle",
        created_at: new Date(),
      });
    } catch (bannerErr) {
      // Non-fatal: don't fail the cycle creation if banner insert fails
      console.error("[auto-banner] failed:", bannerErr.message);
    }

    // Bust the room-list cache so the dashboard picks up the new cycle
    // and re-computes hasPriorUnpaid against the remaining completed cycles.
    cache.del(`roomlist:${req.user.id}:host`);

    res.status(201).json({
      success: true,
      message: "Billing cycle created successfully",
      billingCycle: normalizeBillingCycle(billingCycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET ACTIVE BILLING CYCLE FOR ROOM
// ============================================================
router.get("/room/:roomId/active", isAuthenticated, async (req, res, next) => {
  try {
    const { roomId } = req.params;

    const room = await SupabaseService.findRoomById(roomId);
    if (!room) {
      return next(new ErrorHandler("Room not found", 404));
    }

    const activeCycle = await SupabaseService.getActiveBillingCycle(roomId);

    if (!activeCycle) {
      return res.status(200).json({
        success: true,
        billingCycle: null,
        message: "No active billing cycle",
      });
    }

    // Enrich with live presence-based water data (same as the /room/:roomId endpoint)
    await enrichBillingCycle(activeCycle, null, room);

    res.status(200).json({
      success: true,
      billingCycle: normalizeBillingCycle(activeCycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET ACTIVE OR LATEST CLOSED BILLING CYCLE FOR ROOM
// Small client summary endpoint: avoids returning every historical cycle.
// ============================================================
router.get("/room/:roomId/current", isAuthenticated, async (req, res, next) => {
  try {
    const { roomId } = req.params;

    const [room, cycle] = await Promise.all([
      SupabaseService.findById(
        "rooms",
        roomId,
        "id, water_billing_mode, water_fixed_amount, water_fixed_type",
      ),
      SupabaseService.getCurrentOrLatestBillingCycle(roomId),
    ]);

    if (!room) {
      return next(new ErrorHandler("Room not found", 404));
    }

    if (!cycle) {
      return res.status(200).json({
        success: true,
        billingCycle: null,
        message: "No billing cycle",
      });
    }

    await enrichBillingCycle(cycle, null, room);

    res.status(200).json({
      success: true,
      billingCycle: normalizeBillingCycle(cycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET ALL BILLING CYCLES FOR A ROOM
// ============================================================
router.get("/room/:roomId", isAuthenticated, async (req, res, next) => {
  try {
    const { roomId } = req.params;

    const room = await SupabaseService.findRoomById(roomId);
    if (!room) {
      return next(new ErrorHandler("Room not found", 404));
    }

    const billingCycles = await SupabaseService.getRoomBillingCycles(roomId);

    // Enrich cycles using shared utility (handles rounding & penny remainder)
    const enrichedCycles = await enrichBillingCycles(billingCycles, roomId);

    res.status(200).json({
      success: true,
      billingCycles: enrichedCycles.map(normalizeBillingCycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET OUTSTANDING BALANCE FOR LOGGED-IN USER IN A ROOM
// Returns unpaid total_due from closed billing cycles where the
// user is a payor and has no completed/verified payment.
// Must be before /:cycleId to avoid route collision.
// ============================================================
router.get(
  "/room/:roomId/outstanding",
  isAuthenticated,
  async (req, res, next) => {
    try {
      const { roomId } = req.params;
      const userId = req.user.id;

      // All cycles for this room
      const cacheKey = `outstanding:${roomId}:${userId}`;
      const hit = cache.get(cacheKey);
      if (hit) return res.status(200).json(hit);

      const allCycles =
        (await SupabaseService.getRoomBillingCycles(roomId)) || [];

      // Only completed/closed cycles matter — active cycle debt is tracked in real time
      const closedCycles = allCycles.filter((c) => c.status === "completed");

      // Fetch room members once (needed for fallback calculation)
      const members = (await SupabaseService.getRoomMembers(roomId)) || [];
      const userMember = members.find(
        (m) => String(m.user_id) === String(userId),
      );

      // User is not in this room or is not a payor — nothing to check
      if (!userMember || !userMember.is_payer) {
        return res.status(200).json({
          success: true,
          totalOutstanding: 0,
          unpaidCycles: [],
        });
      }

      // ── Batch fetch: all payments for this room in one query ──
      // Replaces per-cycle getPaymentsForCycle() calls (N queries → 1 query)
      const allRoomPayments =
        await SupabaseService.getAllPaymentsForRoom(roomId);

      const unpaidCycles = [];
      let totalOutstanding = 0;

      for (const cycle of closedCycles) {
        // ── Try stored billing_cycle_charges first ──
        const charges =
          (await SupabaseService.getBillingCycleCharges(cycle.id)) || [];

        let amountDue = 0;

        if (charges.length > 0) {
          // Charges table has data — use stored total_due
          const userCharge = charges.find(
            (c) => String(c.user_id) === String(userId),
          );
          if (!userCharge || !userCharge.is_payer) continue;
          amountDue = parseFloat(userCharge.total_due) || 0;
        } else {
          // ── Fallback: compute per-member share from billing cycle amounts ──
          await enrichBillingCycle(cycle, members);
          const memberCharge = (cycle.member_charges || []).find(
            (mc) => String(mc.user_id) === String(userId),
          );
          if (!memberCharge || !memberCharge.is_payer) continue;
          amountDue = parseFloat(memberCharge.total_due) || 0;

          // Last-resort simple split if enrichment produced 0
          if (amountDue === 0) {
            const payerCount = members.filter(
              (m) => m.is_payer !== false,
            ).length;
            if (payerCount > 0) {
              const rent = parseFloat(cycle.rent || 0);
              const electricity = parseFloat(cycle.electricity || 0);
              const internet = parseFloat(cycle.internet || 0);
              const water = parseFloat(cycle.water_bill_amount || 0);
              amountDue =
                Math.round(
                  ((rent + electricity + internet + water) / payerCount) * 100,
                ) / 100;
            }
          }
        }

        // Filter payments in-memory (no extra DB call per cycle)
        const cyclePayments = allRoomPayments.filter(
          (p) =>
            p.billing_cycle_start === cycle.start_date &&
            p.billing_cycle_end === cycle.end_date,
        );

        const userPaid = cyclePayments.some(
          (p) =>
            String(p.paid_by) === String(userId) &&
            (p.status === "completed" || p.status === "verified"),
        );

        if (!userPaid && amountDue > 0) {
          totalOutstanding += amountDue;
          unpaidCycles.push({
            cycleId: cycle.id,
            cycleNumber: cycle.cycle_number,
            startDate: cycle.start_date,
            endDate: cycle.end_date,
            totalDue: amountDue,
          });
        }
      }

      const payload = { success: true, totalOutstanding, unpaidCycles };
      // Cache for 3 minutes — busted when a payment is verified
      cache.set(cacheKey, payload, 180);
      res.status(200).json(payload);
    } catch (error) {
      next(new ErrorHandler(error.message, 500));
    }
  },
);

// ============================================================
// GET LATEST BILLING CYCLE STATS
// (Must be BEFORE /:cycleId to avoid Express matching "totals" as a cycleId)
// ============================================================
router.get("/totals/latest", isAuthenticated, async (req, res, next) => {
  try {
    const { roomId } = req.query;

    // Get all billing cycles
    const cycles = await SupabaseService.selectAllRecords(
      "billing_cycles",
      "*",
    );

    // Filter to only cycles belonging to rooms created by the current admin
    const allRooms = await SupabaseService.selectAllRecords("rooms", "*");
    let adminRoomIds = (allRooms || [])
      .filter((r) => r.created_by === req.user.id)
      .map((r) => r.id);

    // If roomId provided, narrow down to that single room
    if (roomId && adminRoomIds.includes(roomId)) {
      adminRoomIds = [roomId];
    }

    const adminCycles = (cycles || []).filter((c) =>
      adminRoomIds.includes(c.room_id),
    );

    if (!adminCycles || adminCycles.length === 0) {
      return res.status(200).json({
        success: true,
        stats: {
          activeCycles: 0,
          totalBilled: 0,
          totalCollected: 0,
          totalPending: 0,
          collectionRate: 0,
        },
      });
    }

    // Sort by created_at descending to get latest
    const sortedCycles = adminCycles.sort(
      (a, b) => new Date(b.created_at) - new Date(a.created_at),
    );

    const latestCycle = sortedCycles[0];

    // Enrich with presence-based water charges
    await enrichBillingCycle(latestCycle);

    // Parse custom charges
    let customCharges = [];
    if (latestCycle.custom_charges) {
      try {
        customCharges =
          typeof latestCycle.custom_charges === "string"
            ? JSON.parse(latestCycle.custom_charges)
            : latestCycle.custom_charges;
      } catch (_) {
        customCharges = [];
      }
    }
    const customChargesTotal = customCharges.reduce(
      (sum, c) => sum + parseFloat(c.amount || 0),
      0,
    );

    // Calculate totalBilled from enriched values
    const totalBilled = latestCycle.total_billed_amount
      ? parseFloat(latestCycle.total_billed_amount)
      : parseFloat(latestCycle.rent || 0) +
        parseFloat(latestCycle.electricity || 0) +
        parseFloat(latestCycle.water_bill_amount || 0) +
        parseFloat(latestCycle.internet || 0) +
        customChargesTotal;

    // Get payments matched by billing cycle columns (not payment_date)
    const cyclePayments =
      (await SupabaseService.getPaymentsForCycle(
        latestCycle.room_id,
        latestCycle.start_date,
        latestCycle.end_date,
      )) || [];

    const rawCollected = cyclePayments
      .filter((p) => p.status === "completed" || p.status === "verified")
      .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    // Cap collected at totalBilled to prevent rounding overshoot
    const totalCollected = Math.min(rawCollected, totalBilled);
    const totalPending = Math.max(0, totalBilled - totalCollected);
    const collectionRate =
      totalBilled > 0 ? ((totalCollected / totalBilled) * 100).toFixed(2) : 0;

    res.status(200).json({
      success: true,
      stats: {
        activeCycles: 1,
        totalBilled,
        totalCollected,
        totalPending,
        collectionRate: parseFloat(collectionRate),
        latestCycleId: latestCycle.id,
        roomId: latestCycle.room_id,
        startDate: latestCycle.start_date,
        endDate: latestCycle.end_date,
        cycleStatus: latestCycle.status || "active",
      },
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET BILLING TOTALS BY MONTH
// (Must be BEFORE /:cycleId to avoid Express matching "totals" as a cycleId)
// ============================================================
router.get("/totals/month", isAuthenticated, async (req, res, next) => {
  try {
    const { months = 6, roomId } = req.query;
    const monthCount = parseInt(months) || 6;

    // Get all billing cycles
    const allCycles = await SupabaseService.selectAllRecords(
      "billing_cycles",
      "*",
    );

    // Filter to only cycles belonging to rooms created by the current admin
    const allRooms = await SupabaseService.selectAllRecords("rooms", "*");
    let adminRoomIds = (allRooms || [])
      .filter((r) => r.created_by === req.user.id)
      .map((r) => r.id);

    // If roomId provided, narrow down to that single room
    if (roomId && adminRoomIds.includes(roomId)) {
      adminRoomIds = [roomId];
    }

    const adminCycles = (allCycles || []).filter((c) =>
      adminRoomIds.includes(c.room_id),
    );

    // Filter to rooms that have at least one member
    const allMembers = await SupabaseService.selectAllRecords(
      "room_members",
      "*",
    );
    const roomsWithMembers = new Set((allMembers || []).map((m) => m.room_id));

    const cutoffDate = new Date();
    cutoffDate.setMonth(cutoffDate.getMonth() - monthCount);

    const relevantCycles = (adminCycles || [])
      .filter((cycle) => {
        const cycleDate = new Date(cycle.created_at);
        return cycleDate >= cutoffDate && roomsWithMembers.has(cycle.room_id);
      })
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    const monthlyStats = [];
    for (const cycle of relevantCycles) {
      // Enrich with presence-based water charges
      await enrichBillingCycle(cycle);

      // Parse custom charges
      let customCharges = [];
      if (cycle.custom_charges) {
        try {
          customCharges =
            typeof cycle.custom_charges === "string"
              ? JSON.parse(cycle.custom_charges)
              : cycle.custom_charges;
        } catch (_) {
          customCharges = [];
        }
      }
      const customChargesTotal = customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );

      // Get payments matched by billing cycle columns (not payment_date)
      const cyclePayments =
        (await SupabaseService.getPaymentsForCycle(
          cycle.room_id,
          cycle.start_date,
          cycle.end_date,
        )) || [];

      const totalBilled = cycle.total_billed_amount
        ? parseFloat(cycle.total_billed_amount)
        : parseFloat(cycle.rent || 0) +
          parseFloat(cycle.electricity || 0) +
          parseFloat(cycle.water_bill_amount || 0) +
          parseFloat(cycle.internet || 0) +
          customChargesTotal;
      const rawCollected = cyclePayments
        .filter((p) => p.status === "completed" || p.status === "verified")
        .reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
      const totalCollected = Math.min(rawCollected, totalBilled);

      monthlyStats.push({
        cycleId: cycle.id,
        cycleNumber: cycle.cycle_number,
        month: new Date(cycle.start_date).toLocaleString("default", {
          month: "long",
          year: "numeric",
        }),
        totalBilled,
        totalCollected,
        totalPending: totalBilled - totalCollected,
      });
    }

    res.status(200).json({
      success: true,
      months: monthCount,
      data: monthlyStats,
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET SINGLE BILLING CYCLE
// ============================================================
router.get("/:cycleId", isAuthenticated, async (req, res, next) => {
  try {
    const { cycleId } = req.params;

    const cycle = await SupabaseService.selectByColumn(
      "billing_cycles",
      "id",
      cycleId,
    );

    if (!cycle) {
      return next(new ErrorHandler("Billing cycle not found", 404));
    }

    // Enrich with presence-based water charges
    await enrichBillingCycle(cycle);

    res.status(200).json({
      success: true,
      billingCycle: normalizeBillingCycle(cycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// UPDATE BILLING CYCLE
// ============================================================
router.put("/:cycleId", isAuthenticated, async (req, res, next) => {
  try {
    const { cycleId } = req.params;
    const {
      rent,
      electricity,
      water,
      waterBillAmount,
      internet,
      status,
      startDate,
      endDate,
      previousMeterReading,
      currentMeterReading,
      customCharges,
    } = req.body;

    // console.log("[BILLING-UPDATE] Received customCharges:", customCharges);

    let currentCycle = null;
    const getCurrentCycle = async () => {
      if (!currentCycle) {
        currentCycle = await SupabaseService.selectByColumn(
          "billing_cycles",
          "id",
          cycleId,
        );
      }
      return currentCycle;
    };

    if (startDate !== undefined || endDate !== undefined) {
      const cycle = await getCurrentCycle();
      const effectiveStartDate = startDate || cycle?.start_date;
      const effectiveEndDate = endDate || cycle?.end_date;
      if (new Date(effectiveStartDate) >= new Date(effectiveEndDate)) {
        return next(new ErrorHandler("Start date must be before end date", 400));
      }
    }

    const updateData = {};
    if (startDate !== undefined) updateData.start_date = new Date(startDate);
    if (endDate !== undefined) updateData.end_date = new Date(endDate);
    if (rent !== undefined) updateData.rent = rent;
    if (electricity !== undefined) updateData.electricity = electricity;
    if (waterBillAmount !== undefined)
      updateData.water_bill_amount = waterBillAmount;
    else if (water !== undefined) updateData.water_bill_amount = water;
    if (internet !== undefined) updateData.internet = internet;
    if (status) updateData.status = status;
    if (previousMeterReading != null)
      updateData.previous_meter_reading = previousMeterReading;
    if (currentMeterReading != null)
      updateData.current_meter_reading = currentMeterReading;

    // Handle custom charges
    if (customCharges !== undefined) {
      const customChargesArray = Array.isArray(customCharges)
        ? customCharges
        : [];
      updateData.custom_charges =
        customChargesArray.length > 0
          ? JSON.stringify(customChargesArray)
          : null;
    }

    // Recalculate total_billed_amount if any amount field changed
    if (
      rent !== undefined ||
      electricity !== undefined ||
      waterBillAmount !== undefined ||
      water !== undefined ||
      internet !== undefined ||
      startDate !== undefined ||
      endDate !== undefined ||
      customCharges !== undefined
    ) {
      // Fetch current cycle to get existing values for fields not being updated
      currentCycle = await getCurrentCycle();
      const r = parseFloat(updateData.rent ?? currentCycle?.rent ?? 0);
      const e = parseFloat(
        updateData.electricity ?? currentCycle?.electricity ?? 0,
      );
      const i = parseFloat(updateData.internet ?? currentCycle?.internet ?? 0);

      // Recompute members_count and water from live DB presence data
      const cycleRoomId = currentCycle?.room_id;
      const cycleRoom = cycleRoomId
        ? await SupabaseService.findRoomById(cycleRoomId)
        : null;
      const waterRaw = parseFloat(
        updateData.water_bill_amount ?? currentCycle?.water_bill_amount ?? 0,
      );
      const effectiveStartDate = startDate || currentCycle?.start_date;
      const effectiveEndDate = endDate || currentCycle?.end_date;
      const { membersCount: updMembersCount, waterBillAmount: computedWater } =
        cycleRoomId
          ? await computeCycleStats(
              cycleRoomId,
              effectiveStartDate,
              effectiveEndDate,
              waterRaw,
              cycleRoom?.water_billing_mode,
              cycleRoom?.water_fixed_type,
              cycleRoom?.water_fixed_amount,
            )
          : { membersCount: 0, waterBillAmount: waterRaw };

      const w = computedWater;
      updateData.water_bill_amount = w;
      updateData.members_count = updMembersCount;

      // Add custom charges to total if they exist
      const customChargesArray = Array.isArray(customCharges)
        ? customCharges
        : [];
      const customChargesTotal = customChargesArray.reduce(
        (sum, charge) => sum + parseFloat(charge.amount || 0),
        0,
      );
      updateData.total_billed_amount = r + e + w + i + customChargesTotal;
    }

    const updatedCycle = await SupabaseService.update(
      "billing_cycles",
      cycleId,
      updateData,
    );

    // console.log(
    //   "[BILLING-UPDATE] Updated cycle custom_charges:",
    //   updatedCycle?.custom_charges,
    // );
    const normalized = normalizeBillingCycle(updatedCycle);
    // console.log("[BILLING-UPDATE] Normalized response:", normalized);

    res.status(200).json({
      success: true,
      message: "Billing cycle updated successfully",
      billingCycle: normalized,
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// BACKFILL — recalculate members_count & water_bill_amount
//            for all existing billing cycles in the DB
// POST /api/v1/billing-cycles/backfill-stats
// ============================================================
// ============================================================
// OPEN/CLOSE ACTIVE PAYMENT GATEWAY
// ============================================================
const ensureCycleManager = async (cycle, user) => {
  const role = (user.role || "").toLowerCase();
  if (role === "admin" || user.is_admin) return;

  const room = await SupabaseService.findRoomById(cycle.room_id);
  if (String(room?.created_by) !== String(user.id)) {
    throw new ErrorHandler("You can only manage your own rooms", 403);
  }
};

router.post(
  "/:cycleId/payment-gateway/open",
  isAuthenticated,
  isAdminOrHost,
  async (req, res, next) => {
    try {
      const { cycleId } = req.params;
      const cycle = await SupabaseService.selectByColumn(
        "billing_cycles",
        "id",
        cycleId,
      );

      if (!cycle) return next(new ErrorHandler("Billing cycle not found", 404));
      if (cycle.status !== "active") {
        return next(
          new ErrorHandler("Only active billing cycles can open payments", 400),
        );
      }

      await ensureCycleManager(cycle, req.user);

      const updatedCycle = await SupabaseService.update(
        "billing_cycles",
        cycleId,
        {
          payment_gateway_open: true,
          payment_gateway_opened_at: new Date().toISOString(),
          payment_gateway_opened_by: req.user.id,
          payment_gateway_closed_at: null,
          payment_gateway_closed_by: null,
        },
      );

      cache.del(`roomlist:${req.user.id}:host`);

      res.status(200).json({
        success: true,
        message: "Payment gateway opened",
        billingCycle: normalizeBillingCycle(updatedCycle),
      });
    } catch (error) {
      next(
        error instanceof ErrorHandler
          ? error
          : new ErrorHandler(error.message, 500),
      );
    }
  },
);

router.post(
  "/:cycleId/payment-gateway/close",
  isAuthenticated,
  isAdminOrHost,
  async (req, res, next) => {
    try {
      const { cycleId } = req.params;
      const cycle = await SupabaseService.selectByColumn(
        "billing_cycles",
        "id",
        cycleId,
      );

      if (!cycle) return next(new ErrorHandler("Billing cycle not found", 404));
      if (cycle.status !== "active") {
        return next(
          new ErrorHandler("Only active billing cycles can close payments", 400),
        );
      }

      await ensureCycleManager(cycle, req.user);

      const updatedCycle = await SupabaseService.update(
        "billing_cycles",
        cycleId,
        {
          payment_gateway_open: false,
          payment_gateway_closed_at: new Date().toISOString(),
          payment_gateway_closed_by: req.user.id,
        },
      );

      cache.del(`roomlist:${req.user.id}:host`);

      res.status(200).json({
        success: true,
        message: "Payment gateway closed",
        billingCycle: normalizeBillingCycle(updatedCycle),
      });
    } catch (error) {
      next(
        error instanceof ErrorHandler
          ? error
          : new ErrorHandler(error.message, 500),
      );
    }
  },
);

router.post("/backfill-stats", isAuthenticated, async (req, res, next) => {
  try {
    const allCycles =
      (await SupabaseService.selectAllRecords(
        "billing_cycles",
        "id, room_id, status, start_date, end_date, rent, electricity, water_bill_amount, internet, members_count",
      )) || [];

    let updated = 0;
    let skipped = 0;
    const errors = [];

    for (const cycle of allCycles) {
      try {
        const room = await SupabaseService.findRoomById(cycle.room_id);
        if (!room) {
          skipped++;
          continue;
        }

        const { membersCount, waterBillAmount } = await computeCycleStats(
          cycle.room_id,
          cycle.start_date,
          cycle.end_date,
          cycle.water_bill_amount,
          room.water_billing_mode,
          room.water_fixed_type,
          room.water_fixed_amount,
        );

        const r = parseFloat(cycle.rent || 0);
        const e = parseFloat(cycle.electricity || 0);
        const w = parseFloat(waterBillAmount || 0);
        const i = parseFloat(cycle.internet || 0);

        await SupabaseService.update("billing_cycles", cycle.id, {
          members_count: membersCount,
          water_bill_amount: w,
          total_billed_amount: r + e + w + i,
        });
        updated++;
      } catch (err) {
        errors.push({ cycleId: cycle.id, error: err.message });
        skipped++;
      }
    }

    res.status(200).json({
      success: true,
      message: `Backfill complete. Updated: ${updated}, Skipped: ${skipped}.`,
      updated,
      skipped,
      errors,
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// CLOSE/ARCHIVE BILLING CYCLE
// ============================================================
router.post("/:cycleId/close", isAuthenticated, async (req, res, next) => {
  try {
    const { cycleId } = req.params;

    // Read the cycle first so we can snapshot the current water amount
    // (presence data is cleared immediately after this call in the client,
    //  so we must persist the live-computed value now while presence is still intact).
    const existingCycle = await SupabaseService.selectByColumn(
      "billing_cycles",
      "id",
      cycleId,
    );

    // Compute the current water bill from live presence data before presence is wiped
    let snapshotWater = parseFloat(existingCycle?.water_bill_amount) || 0;
    let snapshotTotal = parseFloat(existingCycle?.total_billed_amount) || 0;
    if (existingCycle) {
      await enrichBillingCycle(existingCycle);
      const computedWater = parseFloat(existingCycle.water_bill_amount) || 0;
      if (computedWater > 0) {
        snapshotWater = computedWater;
        snapshotTotal =
          parseFloat(existingCycle.total_billed_amount) || snapshotTotal;
      }
    }

    const updatedCycle = await SupabaseService.update(
      "billing_cycles",
      cycleId,
      {
        status: "completed",
        closed_at: new Date(),
        closed_by: req.user.id,
        // Persist the live-computed water amount so the completed cycle
        // shows correct values even after presence is cleared for the next cycle.
        water_bill_amount: snapshotWater,
        total_billed_amount: snapshotTotal,
        // Snapshot member_charges so the completed cycle retains the exact
        // per-member water split (presence-based) instead of equal split.
        member_charges: existingCycle.member_charges
          ? JSON.stringify(existingCycle.member_charges)
          : null,
      },
    );

    // Bust the room-list cache so the host's dashboard immediately sees
    // the updated cycleStatus ("cycle_closed" or "completed") on next load.
    cache.del(`roomlist:${req.user.id}:host`);
    // Bust the per-room overdue cache so the billing screen reflects the close immediately.
    if (updatedCycle?.room_id) cache.del(`overdue:${updatedCycle.room_id}`);

    res.status(200).json({
      success: true,
      message: "Billing cycle closed successfully",
      billingCycle: normalizeBillingCycle(updatedCycle),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// GET CHARGES FOR A BILLING CYCLE
// ============================================================
router.get("/:cycleId/charges", isAuthenticated, async (req, res, next) => {
  try {
    const { cycleId } = req.params;

    const charges =
      (await SupabaseService.selectAll(
        "billing_cycle_charges",
        "billing_cycle_id",
        cycleId,
      )) || [];

    // Enrich with user details
    for (let charge of charges) {
      const user = await SupabaseService.findUserById(charge.user_id);
      charge.user = user;
    }

    res.status(200).json({
      success: true,
      charges: (charges || []).map(normalizeCharge),
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

// ============================================================
// DELETE BILLING CYCLE
// ============================================================
router.delete("/:cycleId", isAuthenticated, async (req, res, next) => {
  try {
    const { cycleId } = req.params;

    await SupabaseService.deleteRecord("billing_cycles", cycleId);

    res.status(200).json({
      success: true,
      message: "Billing cycle deleted successfully",
    });
  } catch (error) {
    next(new ErrorHandler(error.message, 500));
  }
});

module.exports = router;
