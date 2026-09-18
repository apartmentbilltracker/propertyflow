// Admin Billing Reports Controller - Supabase
const express = require("express");
const router = express.Router();
const SupabaseService = require("../db/SupabaseService");
const catchAsyncErrors = require("../middleware/catchAsyncErrors");
const ErrorHandler = require("../utils/ErrorHandler");
const { isAuthenticated, isAdminOrHost } = require("../middleware/auth");
const { enrichBillingCycle } = require("../utils/enrichBillingCycle");

const r2 = (value) => Math.round((Number(value || 0) + Number.EPSILON) * 100) / 100;

const CHARGE_SHARE_FIELDS = [
  "rent_share",
  "electricity_share",
  "water_bill_share",
  "internet_share",
  "custom_charges_share",
];

const parseMemberCharges = (charges) => {
  if (typeof charges === "string") {
    try {
      return JSON.parse(charges);
    } catch (_) {
      return [];
    }
  }
  return Array.isArray(charges) ? charges : [];
};

function setChargeTotal(charge, newTotal) {
  const targetTotal = r2(newTotal);
  const currentWaterShare = parseFloat(charge.water_bill_share) || 0;
  const currentWaterOwn = parseFloat(charge.water_own) || 0;
  const currentWaterShared = parseFloat(charge.water_shared_nonpayor) || 0;
  const currentTotal =
    parseFloat(charge.total_due) ||
    CHARGE_SHARE_FIELDS.reduce(
      (sum, field) => r2(sum + (parseFloat(charge[field]) || 0)),
      0,
    );

  if (targetTotal <= 0) {
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
    charge.custom_charges_share = targetTotal;
    charge.total_due = targetTotal;
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
      charge[field] = r2(targetTotal - assigned);
    } else if (currentValue > 0) {
      charge[field] = r2((currentValue / currentTotal) * targetTotal);
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
}

function addChargeDeltaToCustom(charge, delta) {
  const adjustment = r2(delta);
  charge.custom_charges_share = r2(
    (parseFloat(charge.custom_charges_share) || 0) + adjustment,
  );
  charge.total_due = r2((parseFloat(charge.total_due) || 0) + adjustment);
  return charge;
}

// Helper: compute a fallback charge for a member when member_charges is empty
function computeFallbackCharge(member, billingCycle, payerCount) {
  if (!member.is_payer) {
    return {
      user_id: member.user_id,
      name: member.name,
      is_payer: false,
      presence_days: 0,
      rent_share: 0,
      electricity_share: 0,
      water_bill_share: 0,
      internet_share: 0,
      total_due: 0,
    };
  }
  const rent = parseFloat(billingCycle.rent || 0);
  const electricity = parseFloat(billingCycle.electricity || 0);
  const water = parseFloat(billingCycle.water_bill_amount || 0);
  const internet = parseFloat(billingCycle.internet || 0);
  const rentShare = payerCount > 0 ? rent / payerCount : 0;
  const electricityShare = payerCount > 0 ? electricity / payerCount : 0;
  const waterShare = payerCount > 0 ? water / payerCount : 0;
  const internetShare = payerCount > 0 ? internet / payerCount : 0;
  return {
    user_id: member.user_id,
    name: member.name,
    is_payer: true,
    presence_days: 0,
    rent_share: rentShare,
    electricity_share: electricityShare,
    water_bill_share: waterShare,
    internet_share: internetShare,
    total_due: rentShare + electricityShare + waterShare + internetShare,
  };
}

// Set one payor's total and redistribute the difference equally to the others.
router.post(
  "/set-member-total/:cycleId/:memberId",
  isAuthenticated,
  isAdminOrHost,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { cycleId, memberId } = req.params;
      const rawTargetAmount = req.body.targetAmount ?? req.body.amount;
      const targetAmount = r2(rawTargetAmount);
      const reason = String(req.body.reason || "").trim();

      if (
        rawTargetAmount === undefined ||
        rawTargetAmount === null ||
        rawTargetAmount === "" ||
        !Number.isFinite(Number(rawTargetAmount)) ||
        targetAmount < 0
      ) {
        return next(new ErrorHandler("A valid target amount is required", 400));
      }

      const billingCycle = await SupabaseService.selectByColumn(
        "billing_cycles",
        "id",
        cycleId,
      );
      if (!billingCycle) {
        return next(new ErrorHandler("Billing cycle not found", 404));
      }
      if (billingCycle.status !== "active") {
        return next(
          new ErrorHandler("Only active billing cycles can be adjusted", 400),
        );
      }

      const room = await SupabaseService.findRoomById(billingCycle.room_id);
      if (!room) {
        return next(new ErrorHandler("Room not found", 404));
      }
      if (
        String(room.created_by) !== String(req.user.id) &&
        (req.user.role || "").toLowerCase() !== "admin" &&
        req.user.is_admin !== true
      ) {
        return next(new ErrorHandler("You can only adjust your own rooms", 403));
      }

      const members = await SupabaseService.getRoomMembers(
        billingCycle.room_id,
      );
      await enrichBillingCycle(billingCycle, members, room);

      const memberCharges = parseMemberCharges(billingCycle.member_charges).map(
        (charge) => ({ ...charge }),
      );
      const payerCharges = memberCharges.filter(
        (charge) => charge.is_payer !== false,
      );
      const targetCharge = payerCharges.find(
        (charge) => String(charge.user_id) === String(memberId),
      );
      if (!targetCharge) {
        return next(new ErrorHandler("Selected member is not a payor", 400));
      }

      const otherPayors = payerCharges.filter(
        (charge) => String(charge.user_id) !== String(memberId),
      );
      const originalTargetTotal = r2(targetCharge.total_due || 0);
      const redistributionAmount = r2(originalTargetTotal - targetAmount);

      if (redistributionAmount !== 0 && otherPayors.length === 0) {
        return next(
          new ErrorHandler(
            "At least one other payor is required for redistribution",
            400,
          ),
        );
      }

      const otherTotals = [];
      let assignedRedistribution = 0;
      for (let index = 0; index < otherPayors.length; index++) {
        const share =
          index === otherPayors.length - 1
            ? r2(redistributionAmount - assignedRedistribution)
            : r2(redistributionAmount / otherPayors.length);
        const nextTotal = r2((otherPayors[index].total_due || 0) + share);
        if (nextTotal < 0) {
          return next(
            new ErrorHandler(
              "Adjustment would make another payor's total negative",
              400,
            ),
          );
        }
        otherTotals.push(nextTotal);
        assignedRedistribution = r2(assignedRedistribution + share);
      }

      const adjustmentId = `adj-${Date.now()}`;
      const appliedAt = new Date().toISOString();
      const metadata = {
        id: adjustmentId,
        type: "fixed_total_redistribution",
        adjusted_member_id: memberId,
        adjusted_member_name: targetCharge.name,
        original_total_due: originalTargetTotal,
        target_total_due: targetAmount,
        redistributed_amount: redistributionAmount,
        reason,
        applied_by: req.user.id,
        applied_at: appliedAt,
      };

      setChargeTotal(targetCharge, targetAmount);
      otherPayors.forEach((charge, index) => {
        const currentTotal = r2(charge.total_due || 0);
        const delta = r2(otherTotals[index] - currentTotal);
        if (delta >= 0) {
          addChargeDeltaToCustom(charge, delta);
        } else {
          setChargeTotal(charge, otherTotals[index]);
        }
      });

      memberCharges.forEach((charge) => {
        charge.manual_adjustment = true;
        charge.adjustment_metadata = metadata;
        if (String(charge.user_id) === String(memberId)) {
          charge.adjustment_role = "capped_payor";
        } else if (charge.is_payer !== false) {
          charge.adjustment_role = "redistributed_payor";
        }
      });

      const adjustedTotal = payerCharges.reduce(
        (sum, charge) => r2(sum + (parseFloat(charge.total_due) || 0)),
        0,
      );

      const updatedCycle = await SupabaseService.update("billing_cycles", cycleId, {
        member_charges: JSON.stringify(memberCharges),
        total_billed_amount: adjustedTotal,
      });

      res.status(200).json({
        success: true,
        message: "Member total adjusted and redistributed successfully",
        adjustment: metadata,
        billingCycle: updatedCycle,
        memberCharges,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// Get detailed billing breakdown for a cycle
router.get(
  "/breakdown/:cycleId",
  isAuthenticated,
  isAdminOrHost,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { cycleId } = req.params;

      const billingCycle = await SupabaseService.selectByColumn(
        "billing_cycles",
        "id",
        cycleId,
      );
      if (!billingCycle) {
        return next(new ErrorHandler("Billing cycle not found", 404));
      }

      const room = await SupabaseService.findRoomById(billingCycle.room_id);
      if (!room) {
        return next(new ErrorHandler("Room not found", 404));
      }

      // Get room members (only approved)
      const members = await SupabaseService.getRoomMembers(
        billingCycle.room_id,
      );

      // Enrich billing cycle with presence-based water charges
      await enrichBillingCycle(billingCycle, members);

      // Get payments for this cycle
      const payments =
        (await SupabaseService.getPaymentsForCycle(
          billingCycle.room_id,
          billingCycle.start_date,
          billingCycle.end_date,
        )) || [];

      const completedPayments = payments.filter(
        (p) => p.status === "completed" || p.status === "verified",
      );

      const payerCount = members.filter((m) => m.is_payer !== false).length;
      const nonPayerCount = members.length - payerCount;

      // Parse custom charges
      let customCharges = [];
      if (billingCycle.custom_charges) {
        try {
          customCharges =
            typeof billingCycle.custom_charges === "string"
              ? JSON.parse(billingCycle.custom_charges)
              : billingCycle.custom_charges;
        } catch (_) {
          customCharges = [];
        }
      }
      const customChargesTotal = customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );

      const breakdown = {
        cycleNumber: billingCycle.cycle_number,
        startDate: billingCycle.start_date,
        endDate: billingCycle.end_date,
        status: billingCycle.status,
        roomName: room.name,
        roomCode: room.code,
        totalBilled: billingCycle.total_billed_amount,
        billBreakdown: {
          rent: {
            total: billingCycle.rent,
            perPayer:
              payerCount > 0
                ? Number((billingCycle.rent / payerCount).toFixed(2))
                : 0,
            totalPayers: payerCount,
          },
          electricity: {
            total: billingCycle.electricity,
            perPayer:
              payerCount > 0
                ? Number((billingCycle.electricity / payerCount).toFixed(2))
                : 0,
            totalPayers: payerCount,
          },
          water: {
            total: billingCycle.water_bill_amount,
            perPayerDirect: 0,
            nonPayorWaterShare: 0,
          },
          internet: {
            total: billingCycle.internet || 0,
            perPayer:
              payerCount > 0
                ? Number(((billingCycle.internet || 0) / payerCount).toFixed(2))
                : 0,
            totalPayers: payerCount,
          },
          customCharges: {
            total: customChargesTotal,
            items: customCharges,
            perPayer:
              payerCount > 0
                ? Number((customChargesTotal / payerCount).toFixed(2))
                : 0,
            totalPayers: payerCount,
          },
        },
        memberBreakdown: members.map((member) => {
          const hasCharges =
            billingCycle.member_charges &&
            billingCycle.member_charges.length > 0;
          const charge = hasCharges
            ? billingCycle.member_charges.find(
                (c) => c.user_id === member.user_id,
              ) || {}
            : computeFallbackCharge(member, billingCycle, payerCount);

          const WATER_BILL_PER_DAY = 5;
          const ownWaterAmount = Number(
            (
              charge.water_own ??
              (charge.presence_days || 0) * WATER_BILL_PER_DAY
            ).toFixed(2),
          );
          const waterShare = Number((charge.water_bill_share || 0).toFixed(2));
          const sharedNonPayorWater = Number(
            (
              charge.water_shared_nonpayor ?? waterShare - ownWaterAmount
            ).toFixed(2),
          );

          const memberPayments = completedPayments.filter(
            (p) => p.paid_by === member.user_id,
          );

          const rentPayment = memberPayments.find(
            (p) => p.bill_type === "rent",
          );
          const electricityPayment = memberPayments.find(
            (p) => p.bill_type === "electricity",
          );
          const waterPayment = memberPayments.find(
            (p) => p.bill_type === "water",
          );
          const internetPayment = memberPayments.find(
            (p) => p.bill_type === "internet",
          );
          const customChargesPayment = memberPayments.find(
            (p) => p.bill_type === "custom_charges",
          );
          const totalPayment = memberPayments.find(
            (p) => p.bill_type === "total",
          );

          const isTotalPaid = !!totalPayment;
          const customChargesShare = Number(
            Number(
              charge.custom_charges_share ??
                (payerCount > 0 ? customChargesTotal / payerCount : 0),
            ).toFixed(2),
          );

          return {
            userId: member.user_id,
            memberName: charge.name || member.name,
            isPayer: member.is_payer,
            presenceDays: charge.presence_days || 0,
            rentShare: Number((charge.rent_share || 0).toFixed(2)),
            electricityShare: Number(
              (charge.electricity_share || 0).toFixed(2),
            ),
            waterShare: waterShare,
            internetShare: Number((charge.internet_share || 0).toFixed(2)),
            customChargesShare: customChargesShare,
            manualAdjustment: charge.manual_adjustment === true,
            adjustmentRole: charge.adjustment_role || null,
            adjustmentMetadata: charge.adjustment_metadata || null,
            ownWaterAmount: ownWaterAmount,
            sharedNonPayorWater: sharedNonPayorWater,
            waterShareNote: `Own consumption: ₱${ownWaterAmount} + Non-payer share: ₱${sharedNonPayorWater}`,
            totalDue: Number((charge.total_due || 0).toFixed(2)),
            rentStatus: rentPayment || isTotalPaid ? "paid" : "pending",
            electricityStatus:
              electricityPayment || isTotalPaid ? "paid" : "pending",
            waterStatus: waterPayment || isTotalPaid ? "paid" : "pending",
            internetStatus: internetPayment || isTotalPaid ? "paid" : "pending",
            customChargesStatus:
              customChargesPayment || isTotalPaid ? "paid" : "pending",
            customChargesAmount: customChargesShare,
            allPaid:
              !!totalPayment ||
              (!!rentPayment &&
                !!electricityPayment &&
                !!waterPayment &&
                !!internetPayment &&
                !!customChargesPayment),
          };
        }),
        customCharges: customCharges,
        summary: {
          totalRentCharged: Number((billingCycle.rent || 0).toFixed(2)),
          totalElectricityCharged: Number(
            (billingCycle.electricity || 0).toFixed(2),
          ),
          totalWaterCharged: Number(
            (billingCycle.water_bill_amount || 0).toFixed(2),
          ),
          totalInternetCharged: Number((billingCycle.internet || 0).toFixed(2)),
          totalCustomChargesCharged: Number(customChargesTotal.toFixed(2)),
          payerCount,
          nonPayerCount,
          totalMembers: members.length,
        },
      };

      res.status(200).json({
        success: true,
        breakdown,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// Get collection status for billing cycle
router.get(
  "/collection-status/:cycleId",
  isAuthenticated,
  isAdminOrHost,
  catchAsyncErrors(async (req, res, next) => {
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

      const billingCycle = cycle;
      const room = await SupabaseService.findRoomById(billingCycle.room_id);
      if (!room) {
        return next(new ErrorHandler("Room not found", 404));
      }

      const members = await SupabaseService.getRoomMembers(
        billingCycle.room_id,
      );

      // Enrich billing cycle with presence-based water charges
      await enrichBillingCycle(billingCycle, members);

      const payments =
        (await SupabaseService.getPaymentsForCycle(
          billingCycle.room_id,
          billingCycle.start_date,
          billingCycle.end_date,
        )) || [];

      const completedPayments = payments.filter(
        (p) => p.status === "completed" || p.status === "verified",
      );

      // Parse custom charges
      let customCharges = [];
      if (billingCycle.custom_charges) {
        try {
          customCharges =
            typeof billingCycle.custom_charges === "string"
              ? JSON.parse(billingCycle.custom_charges)
              : billingCycle.custom_charges;
        } catch (_) {
          customCharges = [];
        }
      }
      const customChargesTotal = customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );
      const payerCount = members.filter((m) => m.is_payer !== false).length;

      const memberStatus = members
        .filter((m) => m.is_payer !== false)
        .map((member) => {
          const hasCharges =
            billingCycle.member_charges &&
            billingCycle.member_charges.length > 0;
          const charge = hasCharges
            ? billingCycle.member_charges.find(
                (c) => c.user_id === member.user_id,
              ) || {}
            : computeFallbackCharge(
                member,
                billingCycle,
                members.filter((m) => m.is_payer !== false).length,
              );
          const memberPayments = completedPayments.filter(
            (p) => p.paid_by === member.user_id,
          );

          const rentPayment = memberPayments.find(
            (p) => p.bill_type === "rent",
          );
          const electricityPayment = memberPayments.find(
            (p) => p.bill_type === "electricity",
          );
          const waterPayment = memberPayments.find(
            (p) => p.bill_type === "water",
          );
          const internetPayment = memberPayments.find(
            (p) => p.bill_type === "internet",
          );
          const customChargesPayment = memberPayments.find(
            (p) => p.bill_type === "custom_charges",
          );
          const totalPayment = memberPayments.find(
            (p) => p.bill_type === "total",
          );

          const isTotalPaid = !!totalPayment;
          const customChargesShare = Number(
            Number(
              charge.custom_charges_share ??
                (payerCount > 0 ? customChargesTotal / payerCount : 0),
            ).toFixed(2),
          );

          return {
            userId: member.user_id,
            memberName: charge.name || member.name,
            isPayer: member.is_payer,
            totalDue: Number((charge.total_due || 0).toFixed(2)),
            rentStatus: rentPayment || isTotalPaid ? "paid" : "pending",
            electricityStatus:
              electricityPayment || isTotalPaid ? "paid" : "pending",
            waterStatus: waterPayment || isTotalPaid ? "paid" : "pending",
            internetStatus: internetPayment || isTotalPaid ? "paid" : "pending",
            customChargesStatus:
              customChargesPayment || isTotalPaid ? "paid" : "pending",
            rentAmount: Number((charge.rent_share || 0).toFixed(2)),
            electricityAmount: Number(
              (charge.electricity_share || 0).toFixed(2),
            ),
            waterAmount: Number((charge.water_bill_share || 0).toFixed(2)),
            internetAmount: Number((charge.internet_share || 0).toFixed(2)),
            customChargesAmount: customChargesShare,
            manualAdjustment: charge.manual_adjustment === true,
            adjustmentRole: charge.adjustment_role || null,
            adjustmentMetadata: charge.adjustment_metadata || null,
            allPaid:
              !!totalPayment ||
              (!!rentPayment &&
                !!electricityPayment &&
                !!waterPayment &&
                !!internetPayment &&
                !!customChargesPayment),
            rentPaidDate:
              rentPayment?.created_at || totalPayment?.created_at || null,
            electricityPaidDate:
              electricityPayment?.created_at ||
              totalPayment?.created_at ||
              null,
            waterPaidDate:
              waterPayment?.created_at || totalPayment?.created_at || null,
            internetPaidDate:
              internetPayment?.created_at || totalPayment?.created_at || null,
          };
        });

      // Use the canonical total_billed_amount from the enriched cycle
      // instead of re-summing individually-rounded member totals
      const totalDue = billingCycle.total_billed_amount
        ? parseFloat(billingCycle.total_billed_amount)
        : memberStatus.reduce((sum, m) => sum + m.totalDue, 0);
      const totalPaid = memberStatus
        .filter((m) => m.allPaid)
        .reduce((sum, m) => sum + m.totalDue, 0);
      const totalPending = totalDue - totalPaid;
      const fullyPaidMembers = memberStatus.filter((m) => m.allPaid).length;

      const collectionPercentage =
        totalDue > 0 ? Math.round((totalPaid / totalDue) * 100) : 0;

      res.status(200).json({
        success: true,
        cycleId: billingCycle.id,
        cycleNumber: billingCycle.cycle_number,
        cycleStart: billingCycle.start_date,
        cycleEnd: billingCycle.end_date,
        status: billingCycle.status,
        memberStatus,
        summary: {
          totalDue: Number(totalDue.toFixed(2)),
          totalPaid: Number(totalPaid.toFixed(2)),
          totalPending: Number(totalPending.toFixed(2)),
          collectionPercentage,
          fullyPaidMembers,
          totalMembers: memberStatus.length,
          payingMembers: memberStatus.filter((m) => m.isPayer).length,
        },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// Get export data for billing cycle
router.get(
  "/export/:cycleId",
  isAuthenticated,
  isAdminOrHost,
  catchAsyncErrors(async (req, res, next) => {
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

      const billingCycle = cycle;
      const room = await SupabaseService.findRoomById(billingCycle.room_id);
      if (!room) {
        return next(new ErrorHandler("Room not found", 404));
      }

      // Enrich billing cycle with presence-based water charges
      await enrichBillingCycle(billingCycle);

      // Parse custom charges
      let customCharges = [];
      if (billingCycle.custom_charges) {
        try {
          customCharges =
            typeof billingCycle.custom_charges === "string"
              ? JSON.parse(billingCycle.custom_charges)
              : billingCycle.custom_charges;
        } catch (_) {
          customCharges = [];
        }
      }
      const customChargesTotal = customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );

      const exportData = {
        roomName: room.name,
        roomCode: room.code,
        cycleNumber: billingCycle.cycle_number,
        billingPeriod: `${new Date(billingCycle.start_date).toLocaleDateString()} - ${new Date(billingCycle.end_date).toLocaleDateString()}`,
        generatedDate: new Date().toLocaleDateString(),
        summary: {
          totalBilled: Number(billingCycle.total_billed_amount.toFixed(2)),
          rent: Number((billingCycle.rent || 0).toFixed(2)),
          electricity: Number((billingCycle.electricity || 0).toFixed(2)),
          water: Number((billingCycle.water_bill_amount || 0).toFixed(2)),
          internet: Number((billingCycle.internet || 0).toFixed(2)),
          customCharges: Number(customChargesTotal.toFixed(2)),
          status: billingCycle.status,
        },
        memberCharges: (billingCycle.member_charges || []).map((charge) => ({
          memberName: charge.name,
          isPayer: charge.is_payer,
          presenceDays: charge.presence_days,
          rentShare: Number((charge.rent_share || 0).toFixed(2)),
          electricityShare: Number((charge.electricity_share || 0).toFixed(2)),
          waterShare: Number((charge.water_bill_share || 0).toFixed(2)),
          internetShare: Number((charge.internet_share || 0).toFixed(2)),
          customChargesShare: Number(
            (charge.custom_charges_share || 0).toFixed(2),
          ),
          totalDue: Number((charge.total_due || 0).toFixed(2)),
        })),
      };

      res.status(200).json({
        success: true,
        exportData,
        fileName: `billing-cycle-${billingCycle.cycle_number}-${new Date().getTime()}.json`,
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

// Get payment statistics (collected, pending, collection rate)
router.get(
  "/payment-stats",
  isAuthenticated,
  isAdminOrHost,
  catchAsyncErrors(async (req, res, next) => {
    try {
      const { roomId } = req.query;

      // Get all rooms created by admin
      let adminRooms =
        (await SupabaseService.selectAll("rooms", "created_by", req.user.id)) ||
        [];

      // If roomId provided, narrow down to that single room
      if (roomId) {
        adminRooms = adminRooms.filter((r) => r.id === roomId);
      }

      if (!adminRooms || adminRooms.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            totalCollected: 0,
            totalPending: 0,
            collectionRate: 0,
            totalBilled: 0,
          },
        });
      }

      const roomIds = adminRooms.map((r) => r.id);

      // Fetch active billing cycles filtered by room IDs (instead of full table scan)
      const { data: activeCycles, error: cyclesError } =
        await SupabaseService.getClient()
          .from("billing_cycles")
          .select(
            "id, room_id, status, start_date, end_date, cycle_number, rent, electricity, internet, water_bill_amount, total_billed_amount, custom_charges, previous_meter_reading, current_meter_reading, closed_at, created_by, created_at",
          )
          .in("room_id", roomIds)
          .eq("status", "active");
      if (cyclesError) throw new Error(cyclesError.message);

      if (!activeCycles || activeCycles.length === 0) {
        return res.status(200).json({
          success: true,
          data: {
            totalCollected: 0,
            totalPending: 0,
            collectionRate: 0,
            totalBilled: 0,
          },
        });
      }

      // Pre-fetch members for all rooms with active cycles in parallel
      const uniqueRoomIds = [...new Set(activeCycles.map((c) => c.room_id))];
      const membersPerRoom = await Promise.all(
        uniqueRoomIds.map((rid) => SupabaseService.getRoomMembers(rid)),
      );
      const roomMembersMap = new Map();
      uniqueRoomIds.forEach((rid, i) =>
        roomMembersMap.set(rid, membersPerRoom[i]),
      );

      // Enrich all active cycles in parallel (pass pre-fetched members)
      await Promise.all(
        activeCycles.map((cycle) =>
          enrichBillingCycle(cycle, roomMembersMap.get(cycle.room_id)),
        ),
      );

      const totalBilled = activeCycles.reduce((sum, cycle) => {
        let billed;
        if (cycle.total_billed_amount) {
          billed = parseFloat(cycle.total_billed_amount);
        } else {
          // Parse custom charges for fallback calculation
          let customChargesTotal = 0;
          if (cycle.custom_charges) {
            try {
              const customCharges =
                typeof cycle.custom_charges === "string"
                  ? JSON.parse(cycle.custom_charges)
                  : cycle.custom_charges;
              customChargesTotal = customCharges.reduce(
                (s, c) => s + parseFloat(c.amount || 0),
                0,
              );
            } catch (_) {
              customChargesTotal = 0;
            }
          }
          billed =
            parseFloat(cycle.rent || 0) +
            parseFloat(cycle.electricity || 0) +
            parseFloat(cycle.water_bill_amount || 0) +
            parseFloat(cycle.internet || 0) +
            customChargesTotal;
        }
        return sum + (billed || 0);
      }, 0);

      // Fetch payments for all active cycles in parallel
      const allPayments = await Promise.all(
        activeCycles.map((cycle) =>
          SupabaseService.getPaymentsForCycle(
            cycle.room_id,
            cycle.start_date,
            cycle.end_date,
          ),
        ),
      );
      const completedPayments = allPayments
        .flat()
        .filter((p) => p.status === "completed" || p.status === "verified");

      const rawCollected = completedPayments.reduce(
        (sum, p) => sum + (parseFloat(p.amount) || 0),
        0,
      );
      // Cap collected at totalBilled to prevent rounding overshoot
      const totalCollected = Math.min(rawCollected, totalBilled);

      const totalPending = Math.max(0, totalBilled - totalCollected);
      const collectionRate =
        totalBilled > 0 ? Math.round((totalCollected / totalBilled) * 100) : 0;

      res.status(200).json({
        success: true,
        data: {
          totalCollected: Number(totalCollected.toFixed(2)),
          totalPending: Number(totalPending.toFixed(2)),
          collectionRate: collectionRate,
          totalBilled: Number(totalBilled.toFixed(2)),
        },
      });
    } catch (error) {
      return next(new ErrorHandler(error.message, 500));
    }
  }),
);

module.exports = router;
