/**
 * Shared utility to enrich a billing cycle with presence-based water bill data.
 *
 * The billing_cycles table stores water_bill_amount and member_charges, but these
 * may be empty/zero when the cycle is first created. Water bills are computed
 * dynamically from member presence data (₱5/day per member).
 *
 * This function applies that enrichment so that any controller returning billing
 * cycle data includes accurate water charges.
 */
const SupabaseService = require("../db/SupabaseService");

const WATER_RATE_PER_DAY = 5; // ₱5 per day

/** Round to 2 decimal places (cents) */
const r2 = (v) => Math.round((v + Number.EPSILON) * 100) / 100;

const memberId = (member) => String(member?.user_id || "");

const getPreferredWaterPayorIds = (member, payingMembers) => {
  const allPayorIds = payingMembers.map((m) => memberId(m)).filter(Boolean);
  const preferred = Array.isArray(member.water_split_payor_ids)
    ? member.water_split_payor_ids.map(String)
    : [];

  if (member.water_split_mode !== "specific_payors" || preferred.length === 0) {
    return allPayorIds;
  }

  const validPayorIds = new Set(allPayorIds);
  const selected = [...new Set(preferred)].filter((id) =>
    validPayorIds.has(id),
  );
  return selected.length > 0 ? selected : allPayorIds;
};

const distributeWater = (assignments, sources, payorIds, amount, sourceId) => {
  if (!amount || payorIds.length === 0) return;

  const share = r2(amount / payorIds.length);
  let assigned = 0;
  payorIds.forEach((payorId, index) => {
    const portion =
      index === payorIds.length - 1 ? r2(amount - assigned) : share;
    assignments.set(payorId, r2((assignments.get(payorId) || 0) + portion));
    if (!sources.has(payorId)) sources.set(payorId, []);
    sources.get(payorId).push(sourceId);
    assigned = r2(assigned + portion);
  });
};

const waterPreferenceSnapshot = (member) => ({
  water_split_mode: member.water_split_mode || "all_payors",
  water_split_payor_ids: Array.isArray(member.water_split_payor_ids)
    ? member.water_split_payor_ids
    : [],
});

const parseStoredMemberCharges = (charges) => {
  if (typeof charges === "string") {
    try {
      return JSON.parse(charges);
    } catch (_) {
      return null;
    }
  }
  return Array.isArray(charges) ? charges : null;
};

const CHARGE_SHARE_FIELDS = [
  "rent_share",
  "electricity_share",
  "water_bill_share",
  "internet_share",
  "custom_charges_share",
];

const retargetChargeTotal = (charge, targetTotal) => {
  const nextTotal = r2(targetTotal);
  const currentWaterShare = parseFloat(charge.water_bill_share) || 0;
  const currentWaterOwn = parseFloat(charge.water_own) || 0;
  const currentWaterShared = parseFloat(charge.water_shared_nonpayor) || 0;
  const currentTotal =
    parseFloat(charge.total_due) ||
    CHARGE_SHARE_FIELDS.reduce(
      (sum, field) => r2(sum + (parseFloat(charge[field]) || 0)),
      0,
    );

  if (nextTotal <= 0) {
    CHARGE_SHARE_FIELDS.forEach((field) => {
      charge[field] = 0;
    });
    charge.water_own = 0;
    charge.water_shared_nonpayor = 0;
    charge.total_due = 0;
    return charge;
  }

  if (currentTotal <= 0) {
    CHARGE_SHARE_FIELDS.forEach((field) => {
      charge[field] = 0;
    });
    charge.custom_charges_share = nextTotal;
    charge.total_due = nextTotal;
    return charge;
  }

  let assigned = 0;
  let lastNonZeroField = null;
  for (let index = CHARGE_SHARE_FIELDS.length - 1; index >= 0; index--) {
    const field = CHARGE_SHARE_FIELDS[index];
    if ((parseFloat(charge[field]) || 0) > 0) {
      lastNonZeroField = field;
      break;
    }
  }
  if (!lastNonZeroField) lastNonZeroField = "custom_charges_share";

  CHARGE_SHARE_FIELDS.forEach((field) => {
    const currentValue = parseFloat(charge[field]) || 0;
    if (field === lastNonZeroField) {
      charge[field] = r2(nextTotal - assigned);
    } else if (currentValue > 0) {
      charge[field] = r2((currentValue / currentTotal) * nextTotal);
      assigned = r2(assigned + charge[field]);
    } else {
      charge[field] = 0;
    }
  });

  charge.total_due = r2(
    CHARGE_SHARE_FIELDS.reduce(
      (sum, field) => r2(sum + (parseFloat(charge[field]) || 0)),
      0,
    ),
  );

  const adjustedWaterShare = parseFloat(charge.water_bill_share) || 0;
  if (currentWaterShare > 0) {
    const waterRatio = adjustedWaterShare / currentWaterShare;
    charge.water_own = r2(currentWaterOwn * waterRatio);
    charge.water_shared_nonpayor = r2(currentWaterShared * waterRatio);
  } else {
    charge.water_own = adjustedWaterShare;
    charge.water_shared_nonpayor = 0;
  }

  return charge;
};

const applyStoredTotalOverride = (
  cycle,
  memberCharges,
  computedTotal,
  storedTotal,
  enabled,
) => {
  const targetTotal = r2(storedTotal);
  const currentTotal = r2(computedTotal);
  if (cycle.status !== "active") {
    return parseFloat(cycle.total_billed_amount || 0) || currentTotal;
  }

  if (
    !enabled ||
    !Number.isFinite(targetTotal) ||
    targetTotal <= 0 ||
    Math.abs(targetTotal - currentTotal) < 0.01
  ) {
    cycle.total_billed_amount = currentTotal;
    return currentTotal;
  }

  const payerCharges = memberCharges.filter((charge) => charge.is_payer !== false);
  if (payerCharges.length === 0) {
    cycle.total_billed_amount = currentTotal;
    return currentTotal;
  }

  const diff = r2(targetTotal - currentTotal);
  let assigned = 0;
  const nextTotals = [];
  for (let index = 0; index < payerCharges.length; index++) {
    const share =
      index === payerCharges.length - 1
        ? r2(diff - assigned)
        : r2(diff / payerCharges.length);
    const nextTotal = r2((parseFloat(payerCharges[index].total_due) || 0) + share);
    if (nextTotal < 0) {
      cycle.total_billed_amount = currentTotal;
      return currentTotal;
    }
    nextTotals.push(nextTotal);
    assigned = r2(assigned + share);
  }

  payerCharges.forEach((charge, index) => {
    retargetChargeTotal(charge, nextTotals[index]);
    charge.manual_total_override = true;
    charge.total_override_metadata = {
      stored_total_billed_amount: targetTotal,
      computed_total_billed_amount: currentTotal,
      applied_difference: diff,
    };
  });

  cycle.member_charges = memberCharges;
  cycle.total_billed_amount = targetTotal;
  return targetTotal;
};

/**
 * Enrich a single billing cycle with computed member charges from presence data.
 * Mutates the cycle object in-place and also returns it.
 *
 * @param {Object} cycle - Raw billing cycle from DB
 * @param {Array}  [members] - Room members array (fetched if not provided)
 * @returns {Object} The enriched cycle
 */
async function enrichBillingCycle(cycle, members, roomData, options = {}) {
  if (!cycle) return cycle;
  const respectStoredTotalOverride =
    options.respectStoredTotalOverride !== false;
  const storedTotalBilledAmount = parseFloat(cycle.total_billed_amount || 0);

  // Fetch members if not provided
  if (!members) {
    members = await SupabaseService.getRoomMembers(cycle.room_id);
  }

  // ── COMPLETED / CLOSED CYCLES ──
  // Use the snapshotted member_charges persisted at close time (preserves
  // the original presence-based water split). Only fall back to equal split
  // if no snapshot was stored (legacy cycles closed before this fix).
  const storedActiveCharges = parseStoredMemberCharges(cycle.member_charges);
  if (
    cycle.status === "active" &&
    Array.isArray(storedActiveCharges) &&
    storedActiveCharges.some((charge) => charge?.manual_adjustment === true)
  ) {
    cycle.member_charges = storedActiveCharges;
    const adjustedPayerTotal = storedActiveCharges
      .filter((charge) => charge.is_payer !== false)
      .reduce(
        (sum, charge) => r2(sum + (parseFloat(charge.total_due) || 0)),
        0,
      );
    if (adjustedPayerTotal > 0) {
      cycle.total_billed_amount = adjustedPayerTotal;
    }
    applyStoredTotalOverride(
      cycle,
      storedActiveCharges,
      adjustedPayerTotal,
      storedTotalBilledAmount,
      respectStoredTotalOverride,
    );
    return cycle;
  }

  if (cycle.status === "completed" || cycle.status === "closed") {
    // console.log("[ENRICH] Using completed/closed cycle path");
    // Parse stored member_charges if it's a JSON string
    let stored = parseStoredMemberCharges(cycle.member_charges);
    if (Array.isArray(stored) && stored.length > 0) {
      // console.log("[ENRICH] Using stored member_charges");

      // CRITICAL: Add custom_charges_share if missing (for old cycles before this field existed)
      const rent = parseFloat(cycle.rent || 0);
      const electricity = parseFloat(cycle.electricity || 0);
      const internet = parseFloat(cycle.internet || 0);
      let customCharges = [];
      if (cycle.custom_charges) {
        try {
          customCharges =
            typeof cycle.custom_charges === "string"
              ? JSON.parse(cycle.custom_charges)
              : cycle.custom_charges;
        } catch (_) {}
      }
      const customChargesTotal = customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );
      const payerCount = stored.filter((c) => c.is_payer !== false).length;

      // Ensure every member has custom_charges_share
      const customShare =
        payerCount > 0 ? r2(customChargesTotal / payerCount) : 0;
      stored = stored.map((charge) => ({
        ...charge,
        custom_charges_share:
          charge.custom_charges_share !== undefined
            ? charge.custom_charges_share
            : charge.is_payer !== false
              ? customShare
              : 0,
      }));

      cycle.member_charges = stored;
      const storedPayerTotal = stored
        .filter((charge) => charge.is_payer !== false)
        .reduce(
          (sum, charge) => r2(sum + (parseFloat(charge.total_due) || 0)),
          0,
        );
      applyStoredTotalOverride(
        cycle,
        stored,
        storedPayerTotal,
        storedTotalBilledAmount,
        respectStoredTotalOverride,
      );
      return cycle;
    }
    // console.log("[ENRICH] No stored member_charges, falling back to legacy");

    // Legacy fallback: no snapshot — split stored totals evenly among payers
    const rent = parseFloat(cycle.rent || 0);
    const electricity = parseFloat(cycle.electricity || 0);
    const internet = parseFloat(cycle.internet || 0);
    const water = parseFloat(cycle.water_bill_amount || 0);

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

    const payingMembers = members.filter((m) => m.is_payer !== false);
    const payerCount = payingMembers.length;

    const rentShare = payerCount > 0 ? r2(rent / payerCount) : 0;
    const elecShare = payerCount > 0 ? r2(electricity / payerCount) : 0;
    const internetShare = payerCount > 0 ? r2(internet / payerCount) : 0;
    const waterShare = payerCount > 0 ? r2(water / payerCount) : 0;
    const customChargeShare =
      payerCount > 0 ? r2(customChargesTotal / payerCount) : 0;

    let rentAssigned = 0,
      elecAssigned = 0,
      internetAssigned = 0,
      waterAssigned = 0,
      customAssigned = 0;
    let pidx = 0;

    const memberCharges = members.map((member) => {
      let memberRent = 0,
        memberElec = 0,
        memberInternet = 0,
        memberWater = 0,
        memberCustom = 0;

      if (member.is_payer !== false) {
        pidx++;
        if (pidx === payerCount) {
          memberRent = r2(rent - rentAssigned);
          memberElec = r2(electricity - elecAssigned);
          memberInternet = r2(internet - internetAssigned);
          memberWater = r2(water - waterAssigned);
          memberCustom = r2(customChargesTotal - customAssigned);
        } else {
          memberRent = rentShare;
          memberElec = elecShare;
          memberInternet = internetShare;
          memberWater = waterShare;
          memberCustom = customChargeShare;
        }
        rentAssigned = r2(rentAssigned + memberRent);
        elecAssigned = r2(elecAssigned + memberElec);
        internetAssigned = r2(internetAssigned + memberInternet);
        waterAssigned = r2(waterAssigned + memberWater);
        customAssigned = r2(customAssigned + memberCustom);
      }

      return {
        user_id: member.user_id,
        name: member.name || "Unknown",
        is_payer: member.is_payer,
        presence_days: 0,
        rent_share: memberRent,
        electricity_share: memberElec,
        water_bill_share: memberWater,
        water_own: memberWater,
        water_shared_nonpayor: 0,
        internet_share: memberInternet,
        custom_charges_share: memberCustom,
        total_due: r2(
          memberRent + memberElec + memberWater + memberInternet + memberCustom,
        ),
      };
    });

    cycle.member_charges = memberCharges;
    cycle.total_billed_amount = r2(
      rent + electricity + water + internet + customChargesTotal,
    );
    return cycle;
  }

  // Use provided roomData to avoid a DB round-trip when caller already has it
  let waterBillingMode = "presence";
  let waterFixedAmount = 0;
  let waterFixedType = "by_room"; // "by_room" | "per_person"
  try {
    const room =
      roomData || (await SupabaseService.findById("rooms", cycle.room_id));
    waterBillingMode = room?.water_billing_mode || "presence";
    waterFixedAmount = parseFloat(room?.water_fixed_amount || 0) || 0;
    waterFixedType = room?.water_fixed_type || "by_room";
  } catch (_) {}
  // console.log("[ENRICH] Cycle ID:", cycle.id);
  // console.log("[ENRICH] Cycle Status:", cycle.status);
  // console.log("[ENRICH] Water Billing Mode:", waterBillingMode);
  // console.log("[ENRICH] Member count:", members?.length);
  const cycleStart = new Date(cycle.start_date);
  const cycleEnd = new Date(cycle.end_date);
  // For active cycles that have run past their end date, count any presence
  // dates logged after end_date (members still in the cycle) up to today.
  const isActiveCycle = cycle.status === "active";
  const effectiveEnd =
    isActiveCycle && new Date() > cycleEnd ? new Date() : cycleEnd;

  const payingMembers = members.filter((m) => m.is_payer !== false);
  const payerCount = payingMembers.length;

  // Per-payer even splits for rent, electricity, internet — rounded to 2dp
  const rent = parseFloat(cycle.rent || 0);
  const electricity = parseFloat(cycle.electricity || 0);
  const internet = parseFloat(cycle.internet || 0);
  const rentShare = payerCount > 0 ? r2(rent / payerCount) : 0;
  const electricityShare = payerCount > 0 ? r2(electricity / payerCount) : 0;
  const internetShare = payerCount > 0 ? r2(internet / payerCount) : 0;

  // Track running totals for penny-remainder handling
  let rentAssigned = 0;
  let elecAssigned = 0;
  let internetAssigned = 0;
  let payerIndex = 0;

  // Parse custom charges once (used in all branches)
  let customCharges = [];
  if (cycle.custom_charges) {
    try {
      customCharges =
        typeof cycle.custom_charges === "string"
          ? JSON.parse(cycle.custom_charges)
          : cycle.custom_charges;
    } catch (_) {}
  }
  const customChargesTotal = customCharges.reduce(
    (sum, c) => sum + parseFloat(c.amount || 0),
    0,
  );
  const customChargeShare =
    payerCount > 0 ? r2(customChargesTotal / payerCount) : 0;
  // console.log(
  //   "[ENRICH] Custom charges total:",
  //   customChargesTotal,
  //   "share per payer:",
  //   customChargeShare,
  // );

  // ── FIXED MONTHLY WATER ──
  if (waterBillingMode === "fixed_monthly") {
    // per_person: every member is allocated waterFixedAmount; non-payer
    //   shares are redistributed to their chosen payers.
    // by_room:    one total (waterFixedAmount) split equally among payors
    const allMembersCount = members.length || 1;
    const totalFixedWater =
      waterFixedType === "per_person"
        ? r2(waterFixedAmount * allMembersCount)
        : waterFixedAmount;
    const fixedWaterAssignments = new Map();
    const fixedWaterSources = new Map();

    if (waterFixedType === "per_person") {
      members
        .filter((member) => member.is_payer === false)
        .forEach((member) => {
          distributeWater(
            fixedWaterAssignments,
            fixedWaterSources,
            getPreferredWaterPayorIds(member, payingMembers),
            waterFixedAmount,
            memberId(member),
          );
        });
    }

    const fixedWaterPerPayor =
      waterFixedType === "by_room" && payerCount > 0
        ? r2(waterFixedAmount / payerCount)
        : 0;
    let waterAssignedFixed = 0;
    let fixedPayerIndex = 0;

    const memberCharges = members.map((member) => {
      const presenceArr = Array.isArray(member.presence) ? member.presence : [];
      const presenceDays = presenceArr.filter((day) => {
        const d = new Date(day);
        return d >= cycleStart && d <= effectiveEnd;
      }).length;

      let memberRentShare = 0;
      let memberElecShare = 0;
      let memberInternetShare = 0;
      let waterBillShare = 0;

      if (member.is_payer !== false) {
        fixedPayerIndex++;
        // Last payer absorbs rounding remainder for rent/elec/internet
        if (fixedPayerIndex === payerCount) {
          memberRentShare = r2(rent - rentAssigned);
          memberElecShare = r2(electricity - elecAssigned);
          memberInternetShare = r2(internet - internetAssigned);
          waterBillShare =
            waterFixedType === "by_room"
              ? r2(totalFixedWater - waterAssignedFixed)
              : r2(
                  waterFixedAmount +
                    (fixedWaterAssignments.get(memberId(member)) || 0),
                );
        } else {
          memberRentShare = rentShare;
          memberElecShare = electricityShare;
          memberInternetShare = internetShare;
          waterBillShare =
            waterFixedType === "by_room"
              ? fixedWaterPerPayor
              : r2(
                  waterFixedAmount +
                    (fixedWaterAssignments.get(memberId(member)) || 0),
                );
        }
        rentAssigned = r2(rentAssigned + memberRentShare);
        elecAssigned = r2(elecAssigned + memberElecShare);
        internetAssigned = r2(internetAssigned + memberInternetShare);
        waterAssignedFixed = r2(waterAssignedFixed + waterBillShare);
      }

      const totalDue = r2(
        memberRentShare +
          memberElecShare +
          waterBillShare +
          memberInternetShare,
      );

      return {
        user_id: member.user_id,
        name: member.name || "Unknown",
        is_payer: member.is_payer,
        presence_days: presenceDays,
        rent_share: memberRentShare,
        electricity_share: memberElecShare,
        water_bill_share: waterBillShare,
        water_own:
          waterFixedType === "per_person" ? waterFixedAmount : waterBillShare,
        water_shared_nonpayor:
          member.is_payer !== false && waterFixedType === "per_person"
            ? r2(fixedWaterAssignments.get(memberId(member)) || 0)
            : 0,
        water_covered_nonpayor_ids:
          member.is_payer !== false && waterFixedType === "per_person"
            ? fixedWaterSources.get(memberId(member)) || []
            : [],
        ...waterPreferenceSnapshot(member),
        internet_share: memberInternetShare,
        custom_charges_share: member.is_payer !== false ? customChargeShare : 0,
        total_due: r2(
          totalDue + (member.is_payer !== false ? customChargeShare : 0),
        ),
      };
    });

    cycle.member_charges = memberCharges;
    cycle.water_bill_amount = totalFixedWater;
    cycle.total_billed_amount = r2(
      rent + electricity + totalFixedWater + internet + customChargesTotal,
    );

    // Correct last payer total_due for any rounding
    const payerCharges = memberCharges.filter((c) => c.is_payer !== false);
    if (payerCharges.length > 0) {
      if (waterFixedType === "per_person") {
        const waterSum = payerCharges.reduce(
          (s, c) => r2(s + (c.water_bill_share || 0)),
          0,
        );
        const waterDiff = r2(totalFixedWater - waterSum);
        if (waterDiff !== 0) {
          const lastPayer = payerCharges[payerCharges.length - 1];
          lastPayer.water_bill_share = r2(
            (lastPayer.water_bill_share || 0) + waterDiff,
          );
          lastPayer.water_shared_nonpayor = r2(
            (lastPayer.water_shared_nonpayor || 0) + waterDiff,
          );
          lastPayer.total_due = r2((lastPayer.total_due || 0) + waterDiff);
        }
      }

      const sumPayerTotals = payerCharges.reduce(
        (s, c) => r2(s + c.total_due),
        0,
      );
      const diff = r2(cycle.total_billed_amount - sumPayerTotals);
      if (diff !== 0) {
        payerCharges[payerCharges.length - 1].total_due = r2(
          payerCharges[payerCharges.length - 1].total_due + diff,
        );
      }
    }
    applyStoredTotalOverride(
      cycle,
      memberCharges,
      cycle.total_billed_amount,
      storedTotalBilledAmount,
      respectStoredTotalOverride,
    );
    return cycle;
  }

  // ── PASS 1: Compute each member's individual water consumption ──
  let nonPayorWaterTotal = 0;
  const memberWaterOwn = members.map((member) => {
    const presenceArr = Array.isArray(member.presence) ? member.presence : [];
    const presenceDays = presenceArr.filter((day) => {
      const d = new Date(day);
      return d >= cycleStart && d <= effectiveEnd;
    }).length;

    const ownWater = r2(presenceDays * WATER_RATE_PER_DAY);
    if (!member.is_payer) {
      nonPayorWaterTotal = r2(nonPayorWaterTotal + ownWater);
    }
    return { member, presenceDays, ownWater };
  });

  const rawTotalWater = memberWaterOwn.reduce(
    (sum, m) => r2(sum + m.ownWater),
    0,
  );

  // For presence-based water (active cycles): live presence is the truth.
  // The stored water_bill_amount may be stale (e.g. set at cycle creation
  // before members logged presence). Always use the live-computed total
  // so member shares reflect actual presence days without distortion.
  const storedWaterAmount = parseFloat(cycle.water_bill_amount || 0);

  // Active presence-based cycles: trust live computation, no scaling
  const targetWaterTotal = rawTotalWater;
  const waterScale = 1;
  const waterAssignments = new Map();
  const waterAssignmentSources = new Map();

  memberWaterOwn
    .filter(({ member }) => member.is_payer === false)
    .forEach(({ member, ownWater }) => {
      distributeWater(
        waterAssignments,
        waterAssignmentSources,
        getPreferredWaterPayorIds(member, payingMembers),
        r2(ownWater * waterScale),
        memberId(member),
      );
    });

  // console.log(
  //   "[enrichBillingCycle] WATER DEBUG:",
  //   JSON.stringify({
  //     storedWaterAmount,
  //     rawTotalWater,
  //     waterScale,
  //     targetWaterTotal,
  //     nonPayorWaterTotal,
  //     payerCount,
  //     members: memberWaterOwn.map((m) => ({
  //       name: m.member.name,
  //       is_payer: m.member.is_payer,
  //       presenceDays: m.presenceDays,
  //       ownWater: m.ownWater,
  //     })),
  //   }),
  // );

  // ── PASS 2: Build final member charges (with non-payor water distributed) ──
  let totalWater = 0;
  let waterAssigned = 0;
  const memberCharges = memberWaterOwn.map(
    ({ member, presenceDays, ownWater }) => {
      let memberRentShare = 0;
      let memberElecShare = 0;
      let memberInternetShare = 0;
      // Scale the raw water to match admin-set bill
      const scaledOwnWater = r2(ownWater * waterScale);
      let waterBillShare = scaledOwnWater; // non-payors keep their own scaled consumption

      if (member.is_payer) {
        payerIndex++;
        const assignedNonPayorWater = r2(
          waterAssignments.get(memberId(member)) || 0,
        );
        waterBillShare = r2(scaledOwnWater + assignedNonPayorWater);

        if (payerIndex === payerCount) {
          // Last payer gets the remainder to ensure sum == total exactly
          memberRentShare = r2(rent - rentAssigned);
          memberElecShare = r2(electricity - elecAssigned);
          memberInternetShare = r2(internet - internetAssigned);
        } else {
          memberRentShare = rentShare;
          memberElecShare = electricityShare;
          memberInternetShare = internetShare;
        }
        rentAssigned = r2(rentAssigned + memberRentShare);
        elecAssigned = r2(elecAssigned + memberElecShare);
        internetAssigned = r2(internetAssigned + memberInternetShare);
        waterAssigned = r2(waterAssigned + waterBillShare);
        totalWater = r2(totalWater + waterBillShare);
      }

      const totalDue = r2(
        memberRentShare +
          memberElecShare +
          waterBillShare +
          memberInternetShare,
      );

      return {
        user_id: member.user_id,
        name: member.name || "Unknown",
        is_payer: member.is_payer,
        presence_days: presenceDays,
        rent_share: memberRentShare,
        electricity_share: memberElecShare,
        water_bill_share: waterBillShare,
        water_own: scaledOwnWater,
        water_shared_nonpayor: member.is_payer
          ? r2(waterAssignments.get(memberId(member)) || 0)
          : 0,
        water_covered_nonpayor_ids: member.is_payer
          ? waterAssignmentSources.get(memberId(member)) || []
          : [],
        ...waterPreferenceSnapshot(member),
        internet_share: memberInternetShare,
        custom_charges_share: member.is_payer ? customChargeShare : 0,
        total_due: r2(totalDue + (member.is_payer ? customChargeShare : 0)),
      };
    },
  );

  cycle.member_charges = memberCharges;

  // For presence-based active cycles, always update water_bill_amount to the
  // live-computed total so the DB stays in sync with actual presence data.
  cycle.water_bill_amount = targetWaterTotal;

  // Recalculate total_billed_amount to include the (possibly scaled) target water and custom charges
  cycle.total_billed_amount = r2(
    rent + electricity + targetWaterTotal + internet + customChargesTotal,
  );

  // ── Final pass: correct last payer's total_due so sum matches total_billed_amount ──
  const payerCharges = memberCharges.filter((c) => c.is_payer !== false);
  if (payerCharges.length > 0) {
    const waterSum = payerCharges.reduce(
      (s, c) => r2(s + (c.water_bill_share || 0)),
      0,
    );
    const waterDiff = r2(targetWaterTotal - waterSum);
    if (waterDiff !== 0) {
      const lastPayer = payerCharges[payerCharges.length - 1];
      lastPayer.water_bill_share = r2(
        (lastPayer.water_bill_share || 0) + waterDiff,
      );
      lastPayer.water_shared_nonpayor = r2(
        (lastPayer.water_shared_nonpayor || 0) + waterDiff,
      );
      lastPayer.total_due = r2((lastPayer.total_due || 0) + waterDiff);
    }

    const sumPayerTotals = payerCharges.reduce(
      (s, c) => r2(s + c.total_due),
      0,
    );
    const diff = r2(cycle.total_billed_amount - sumPayerTotals);
    if (diff !== 0) {
      const lastPayer = payerCharges[payerCharges.length - 1];
      lastPayer.total_due = r2(lastPayer.total_due + diff);
    }
  }

  applyStoredTotalOverride(
    cycle,
    memberCharges,
    cycle.total_billed_amount,
    storedTotalBilledAmount,
    respectStoredTotalOverride,
  );

  return cycle;
}

/**
 * Enrich multiple billing cycles.
 *
 * @param {Array}  cycles - Array of raw billing cycles
 * @param {string} roomId - The room ID (used to fetch members once)
 * @returns {Array} Enriched cycles
 */
async function enrichBillingCycles(cycles, roomId) {
  if (!cycles || cycles.length === 0) return cycles || [];

  const rid = roomId || cycles[0].room_id;
  const [members, roomData] = await Promise.all([
    SupabaseService.getRoomMembers(rid),
    SupabaseService.findById("rooms", rid).catch(() => null),
  ]);

  for (const cycle of cycles) {
    await enrichBillingCycle(cycle, members, roomData);
  }

  return cycles;
}

module.exports = {
  enrichBillingCycle,
  enrichBillingCycles,
  WATER_RATE_PER_DAY,
};
