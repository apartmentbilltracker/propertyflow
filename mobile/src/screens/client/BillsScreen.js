import React, { useState, useEffect, useContext, useRef } from "react";
import { useFocusEffect } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Modal,
  Image,
  Dimensions,
  Animated,
} from "react-native";
import { MaterialIcons, Ionicons, FontAwesome } from "@expo/vector-icons";
import ViewShot from "react-native-view-shot";
import * as MediaLibrary from "expo-media-library";
import {
  roomService,
  billingCycleService,
  paymentService,
} from "../../services/apiService";
import { AuthContext } from "../../context/AuthContext";
import { roundTo2 as r2 } from "../../utils/helpers";
import { useTheme } from "../../theme/ThemeContext";
import { ScrollViewWithDetection } from "../../components/ScrollDetectionWrappers";
import { Toast } from "../../components/CustomAlert";
import SelectivePaymentModal from "../../components/SelectivePaymentModal";
import {
  buildBillSharesFromCharge,
  findUserCharge,
} from "../../utils/paymentAmounts";
import HomeSpaceLoader from "../../components/SpaceLoader";

const { width: SCREEN_WIDTH } = Dimensions.get("window");
const WATER_BILL_PER_DAY = 5;

const AmountSkeleton = ({ style, colors }) => {
  const opacity = useRef(new Animated.Value(0.45)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.9,
          duration: 650,
          useNativeDriver: true,
        }),
        Animated.timing(opacity, {
          toValue: 0.45,
          duration: 650,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[
        {
          backgroundColor: colors.skeleton || colors.borderLight,
          borderRadius: 999,
          opacity,
        },
        style,
      ]}
    />
  );
};

const filterPresenceByDates = (presenceArr, start, end) => {
  if (!presenceArr || !Array.isArray(presenceArr)) return [];
  if (!start || !end) return presenceArr;
  const s = new Date(start);
  s.setHours(0, 0, 0, 0);
  const e = new Date(end);
  e.setHours(23, 59, 59, 999);
  return presenceArr.filter((day) => {
    const d = new Date(day);
    return d >= s && d <= e;
  });
};

const BillsScreen = ({ navigation, route }) => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(colors, insets);

  const { state } = useContext(AuthContext);
  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [activeCycle, setActiveCycle] = useState(null);
  const [loading, setLoading] = useState(true);
  const [billingDataLoading, setBillingDataLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [memberPresence, setMemberPresence] = useState({});
  const [receiptData, setReceiptData] = useState(null);
  const [showReceiptModal, setShowReceiptModal] = useState(false);
  const [showPaymentReceipt, setShowPaymentReceipt] = useState(false);
  const [paymentReceiptData, setPaymentReceiptData] = useState(null);
  const [currentPaymentBreakdown, setCurrentPaymentBreakdown] = useState(null);
  const [selectedMemberPresence, setSelectedMemberPresence] = useState(null);
  const [showPresenceModal, setShowPresenceModal] = useState(false);
  const [presenceMonth, setPresenceMonth] = useState(new Date());
  const [userPendingPayment, setUserPendingPayment] = useState(null);
  const [outstandingBalance, setOutstandingBalance] = useState({
    totalOutstanding: 0,
    unpaidCycles: [],
  });
  const [downloadingPDF, setDownloadingPDF] = useState(false);
  const viewShotRef = useRef(null);
  const billingStmtRef = useRef(null);
  const paymentReceiptRef = useRef(null);
  const [showBillingStmt, setShowBillingStmt] = useState(false);
  const [showSelectivePaymentModal, setShowSelectivePaymentModal] =
    useState(false);
  const [showNonPayorWaterModal, setShowNonPayorWaterModal] = useState(false);
  const [toast, setToast] = useState({
    visible: false,
    type: "success",
    message: "",
  });
  const lastRoomsFetchRef = useRef(0);

  const showToast = (message, type = "success") =>
    setToast({ visible: true, type, message });

  const userId = state?.user?.id || state?.user?._id;

  const loadBillingData = async (roomId, showSkeleton = true) => {
    if (!roomId) {
      setBillingDataLoading(false);
      return;
    }

    if (showSkeleton) setBillingDataLoading(true);
    try {
      await Promise.all([
        fetchActiveBillingCycle(roomId),
        fetchUserPendingPayment(roomId),
        fetchOutstandingBalance(roomId),
      ]);
    } finally {
      if (showSkeleton) setBillingDataLoading(false);
    }
  };

  useFocusEffect(
    React.useCallback(() => {
      const now = Date.now();
      if (now - lastRoomsFetchRef.current > 30000) {
        lastRoomsFetchRef.current = now;
        fetchRooms(false);
      }
    }, [selectedRoom, userId]),
  );

  useEffect(() => {
    if (selectedRoom) {
      const roomId = selectedRoom.id || selectedRoom._id;
      setActiveCycle(null);
      setUserPendingPayment(null);
      setOutstandingBalance({ totalOutstanding: 0, unpaidCycles: [] });
      extractMemberPresence(selectedRoom);
      loadBillingData(roomId);
    } else {
      setBillingDataLoading(false);
    }
  }, [selectedRoom]);

  useEffect(() => {
    if (route.params?.refresh && selectedRoom) {
      const roomId = selectedRoom.id || selectedRoom._id;
      loadBillingData(roomId);
      route.params.refresh = false;
    }
  }, [route.params?.refresh, selectedRoom]);

  const extractMemberPresence = (room) => {
    if (room?.members) {
      const presenceMap = {};
      room.members.forEach((member) => {
        presenceMap[member.id || member._id] = member.presence || [];
      });
      setMemberPresence(presenceMap);
    }
  };

  const fetchActiveBillingCycle = async (roomId) => {
    try {
      const cycleResponse = await billingCycleService.getCurrentCycle(roomId);
      setActiveCycle(
        cycleResponse?.billingCycle || cycleResponse?.data || null,
      );
    } catch (error) {
      setActiveCycle(null);
    }
  };

  const fetchUserPendingPayment = async (roomId) => {
    try {
      const response = await paymentService.getPaymentHistory(roomId, {
        status: "pending",
        limit: 1,
        includeUser: false,
      });
      const payments = response?.payments || [];
      const pending = payments.find(
        (p) => p.status === "submitted" || p.status === "rejected",
      );
      setUserPendingPayment(pending || null);
    } catch (_) {
      setUserPendingPayment(null);
    }
  };

  const fetchOutstandingBalance = async (roomId) => {
    try {
      const res = await billingCycleService.getOutstandingBalance(roomId);
      setOutstandingBalance({
        totalOutstanding: res?.totalOutstanding || 0,
        unpaidCycles: res?.unpaidCycles || [],
      });
    } catch (_) {
      setOutstandingBalance({ totalOutstanding: 0, unpaidCycles: [] });
    }
  };

  const fetchRooms = async (skipAutoSelect = false) => {
    try {
      setLoading(true);
      const response = await roomService.getClientRooms();
      const data = response.data || response;
      const fetchedRooms = data.rooms || data || [];
      setRooms(fetchedRooms);
      if (fetchedRooms.length === 0) {
        setBillingDataLoading(false);
      }

      if (!skipAutoSelect) {
        if (selectedRoom && fetchedRooms.length > 0) {
          const updatedSelectedRoom = fetchedRooms.find(
            (room) =>
              (room.id || room._id) === (selectedRoom.id || selectedRoom._id),
          );
          if (updatedSelectedRoom) {
            setBillingDataLoading(true);
            setSelectedRoom(updatedSelectedRoom);
          }
        } else if (fetchedRooms.length > 0) {
          setBillingDataLoading(true);
          setSelectedRoom(fetchedRooms[0]);
        }
      }
    } catch (error) {
      showToast("Failed to load rooms", "error");
    } finally {
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchRooms();
    setRefreshing(false);
  };

  const getStatementTypeAndFilename = () => {
    const currentMember = selectedRoom?.members?.find(
      (m) => String(m.user?.id || m.user?._id || m.user) === String(userId),
    );
    const isPayor = currentMember?.isPayer;
    const roomName = selectedRoom?.name || "Room";
    const startDate = new Date(selectedRoom.billing.start);
    const endDate = new Date(selectedRoom.billing.end);
    const dateFormat = `${startDate.getFullYear()}-${String(startDate.getMonth() + 1).padStart(2, "0")}-${String(startDate.getDate()).padStart(2, "0")}`;
    const statementType = isPayor ? "Payor" : "NonPayor";
    const filename = `${roomName}_${statementType}_Statement_${dateFormat}`;

    return { isPayor, statementType, filename, currentMember };
  };

  const downloadBillingImage = async () => {
    try {
      if (!selectedRoom?.billing) {
        showToast("No billing information available", "error");
        return;
      }
      setDownloadingPDF(true);
      const billShare = calculateBillShare();
      if (!billShare) {
        showToast("Could not calculate bill shares", "error");
        setDownloadingPDF(false);
        return;
      }
      const { isPayor, filename } = getStatementTypeAndFilename();
      setShowBillingStmt(true);
      setTimeout(async () => {
        try {
          if (billingStmtRef.current) {
            const uri = await billingStmtRef.current.capture();
            const { status } = await MediaLibrary.requestPermissionsAsync();
            if (status === "granted") {
              const asset = await MediaLibrary.createAssetAsync(uri);
              await MediaLibrary.createAlbumAsync(
                "BillingStatements",
                asset,
                false,
              );
              showToast(
                isPayor
                  ? `Payor invoice saved as "${filename}"`
                  : `Non-payor statement saved as "${filename}"`,
                "success",
              );
            } else {
              showToast(
                "Cannot access photo library. Please grant permission in Settings.",
                "error",
              );
            }
          }
        } catch (error) {
          showToast("Failed to save image: " + error.message, "error");
        } finally {
          setShowBillingStmt(false);
          setDownloadingPDF(false);
        }
      }, 500);
    } catch (error) {
      setDownloadingPDF(false);
      showToast("Failed to export image: " + error.message, "error");
    }
  };

  const downloadPaymentReceipt = async () => {
    try {
      setDownloadingPDF(true);
      setTimeout(async () => {
        try {
          if (paymentReceiptRef.current) {
            const uri = await paymentReceiptRef.current.capture();
            const { status } = await MediaLibrary.requestPermissionsAsync();
            if (status === "granted") {
              const asset = await MediaLibrary.createAssetAsync(uri);
              await MediaLibrary.createAlbumAsync(
                "PaymentReceipts",
                asset,
                false,
              );
              showToast(
                `Payment receipt saved as "Receipt_${paymentReceiptData?.receiptNumber}"`,
                "success",
              );
            } else {
              showToast(
                "Cannot access photo library. Please grant permission in Settings.",
                "error",
              );
            }
          }
        } catch (error) {
          showToast("Failed to save receipt: " + error.message, "error");
        } finally {
          setShowPaymentReceipt(false);
          setDownloadingPDF(false);
        }
      }, 500);
    } catch (error) {
      setDownloadingPDF(false);
      showToast("Failed to download receipt: " + error.message, "error");
    }
  };

  const calculateBillShare = () => {
    if (!selectedRoom?.billing || !userId) return null;

    if (activeCycle?.memberCharges?.length > 0) {
      const userCharge = findUserCharge(activeCycle.memberCharges, userId);
      if (userCharge) {
        return {
          ...buildBillSharesFromCharge(userCharge),
          payorCount: activeCycle.memberCharges.filter(
            (c) => c.isPayer || c.is_payer,
          ).length,
        };
      }
    }

    const billing = selectedRoom.billing;
    const members = selectedRoom.members || [];
    const payorCount = Math.max(
      1,
      members.filter((m) => m.isPayer).length || 1,
    );

    const rentPerPayor = billing.rent ? r2(billing.rent / payorCount) : 0;
    const electricityPerPayor = billing.electricity
      ? r2(billing.electricity / payorCount)
      : 0;
    const internetPerPayor = billing.internet
      ? r2(billing.internet / payorCount)
      : 0;
    const isFixedWater =
      selectedRoom.waterBillingMode === "fixed_monthly" ||
      selectedRoom.water_billing_mode === "fixed_monthly";
    const currentUserMember = selectedRoom.members.find(
      (m) => String(m.user?.id || m.user?._id || m.user) === String(userId),
    );

    let waterShare = 0;
    if (isFixedWater) {
      if (activeCycle) {
        const fixedTotal =
          parseFloat(
            selectedRoom.waterFixedAmount ||
              selectedRoom.water_fixed_amount ||
              0,
          ) || 0;
        const isPerPerson =
          (selectedRoom.waterFixedType || selectedRoom.water_fixed_type) ===
          "per_person";
        if (isPerPerson) {
          waterShare = fixedTotal;
        } else if (currentUserMember?.isPayer) {
          waterShare = r2(fixedTotal / payorCount);
        }
      }
    } else if (
      currentUserMember?.isPayer &&
      memberPresence[currentUserMember.id || currentUserMember._id]
    ) {
      const userPresenceDays = getFilteredPresence(
        currentUserMember.id || currentUserMember._id,
      ).length;
      const userOwnWater = userPresenceDays * WATER_BILL_PER_DAY;
      let nonPayorWater = 0;
      members.forEach((m) => {
        if (!m.isPayer) {
          const presenceDays = getFilteredPresence(m.id || m._id).length;
          nonPayorWater += presenceDays * WATER_BILL_PER_DAY;
        }
      });
      const sharedNonPayorWater =
        payorCount > 0 ? r2(nonPayorWater / payorCount) : 0;
      waterShare = r2(userOwnWater + sharedNonPayorWater);
    }

    let customChargesShare = 0;
    if (currentUserMember?.isPayer && activeCycle?.customCharges?.length > 0) {
      const totalCustomCharges = activeCycle.customCharges.reduce(
        (sum, c) => sum + parseFloat(c.amount || 0),
        0,
      );
      customChargesShare =
        totalCustomCharges > 0 ? r2(totalCustomCharges / payorCount) : 0;
    }

    return {
      rent: rentPerPayor,
      electricity: electricityPerPayor,
      internet: internetPerPayor,
      water: waterShare,
      customCharges: customChargesShare,
      total: r2(
        rentPerPayor +
          electricityPerPayor +
          internetPerPayor +
          waterShare +
          customChargesShare,
      ),
      payorCount,
    };
  };

  const getFilteredPresence = (memberId) => {
    const raw = memberPresence[memberId] || [];
    return filterPresenceByDates(
      raw,
      selectedRoom?.billing?.start,
      selectedRoom?.billing?.end,
    );
  };

  const calculateTotalWaterBill = () => {
    if (
      selectedRoom?.waterBillingMode === "fixed_monthly" ||
      selectedRoom?.water_billing_mode === "fixed_monthly"
    ) {
      if (!activeCycle) return 0;
      const fixedAmt =
        parseFloat(
          selectedRoom?.waterFixedAmount ||
            selectedRoom?.water_fixed_amount ||
            0,
        ) || 0;
      const isPerPerson =
        (selectedRoom?.waterFixedType || selectedRoom?.water_fixed_type) ===
        "per_person";
      if (isPerPerson) {
        const allMembersCount = Math.max(
          1,
          (selectedRoom.members || []).length,
        );
        return r2(fixedAmt * allMembersCount);
      }
      return fixedAmt;
    }
    if (!selectedRoom?.members || selectedRoom.members.length === 0) return 0;
    let totalDays = 0;
    selectedRoom.members.forEach((member) => {
      totalDays += getFilteredPresence(member.id || member._id).length;
    });
    return totalDays * WATER_BILL_PER_DAY;
  };

  const getUserPaymentStatus = () => {
    if (!selectedRoom || !userId) return null;
    return (
      selectedRoom.memberPayments?.find(
        (mp) => String(mp.member) === String(userId),
      ) || null
    );
  };

  const getRemainingDue = () => {
    if (!billShare) return 0;
    const userPayment = getUserPaymentStatus();
    if (!userPayment) return billShare.total;
    let totalPaid = 0;
    if (userPayment.rentStatus === "paid") totalPaid += billShare.rent || 0;
    if (userPayment.electricityStatus === "paid")
      totalPaid += billShare.electricity || 0;
    if (userPayment.waterStatus === "paid") totalPaid += billShare.water || 0;
    if (userPayment.internetStatus === "paid")
      totalPaid += billShare.internet || 0;
    if (userPayment.customChargesStatus === "paid")
      totalPaid += billShare.customCharges || 0;
    return Math.max(0, r2(billShare.total - totalPaid));
  };

  const hasUserPaidAllBills = () => {
    const userPayment = getUserPaymentStatus();
    if (!userPayment) return false;
    const hasCustomCharges =
      (activeCycle?.customCharges && activeCycle.customCharges.length > 0) ||
      (billShare?.customCharges || 0) > 0;
    return (
      userPayment.rentStatus === "paid" &&
      userPayment.electricityStatus === "paid" &&
      userPayment.waterStatus === "paid" &&
      userPayment.internetStatus === "paid" &&
      (!hasCustomCharges || userPayment.customChargesStatus === "paid")
    );
  };

  const calculateMemberWaterBill = (memberId) => {
    if (!selectedRoom?.members) return 0;
    if (
      selectedRoom.waterBillingMode === "fixed_monthly" ||
      selectedRoom.water_billing_mode === "fixed_monthly"
    ) {
      if (!activeCycle) return 0;
      const fixedTotal =
        parseFloat(
          selectedRoom.waterFixedAmount || selectedRoom.water_fixed_amount || 0,
        ) || 0;
      const isPerPerson =
        (selectedRoom.waterFixedType || selectedRoom.water_fixed_type) ===
        "per_person";
      if (isPerPerson) return fixedTotal;
      const memberCount = Math.max(1, selectedRoom.members.length);
      return r2(fixedTotal / memberCount);
    }
    const member = selectedRoom.members.find(
      (m) => (m.id || m._id) === memberId,
    );
    if (!member) return 0;
    return getFilteredPresence(memberId).length * WATER_BILL_PER_DAY;
  };

  const calculateMemberWaterShare = (memberId) => {
    if (!selectedRoom?.members) return 0;
    const member = selectedRoom.members.find(
      (m) => (m.id || m._id) === memberId,
    );
    if (!member) return 0;
    if (!member.isPayer) {
      const isPerPerson =
        (selectedRoom.waterFixedType || selectedRoom.water_fixed_type) ===
        "per_person";
      const isFixed =
        selectedRoom.waterBillingMode === "fixed_monthly" ||
        selectedRoom.water_billing_mode === "fixed_monthly";
      if (isFixed && isPerPerson && activeCycle) {
        return (
          parseFloat(
            selectedRoom.waterFixedAmount ||
              selectedRoom.water_fixed_amount ||
              0,
          ) || 0
        );
      }
      return 0;
    }
    if (activeCycle?.memberCharges?.length > 0 && userId) {
      const userCharge = findUserCharge(activeCycle.memberCharges, memberId);
      if (userCharge && (userCharge.isPayer || userCharge.is_payer)) {
        return userCharge.waterBillShare || userCharge.water_bill_share || 0;
      }
    }
    const payorCount =
      selectedRoom.members.filter((m) => m.isPayer).length || 1;
    if (
      selectedRoom.waterBillingMode === "fixed_monthly" ||
      selectedRoom.water_billing_mode === "fixed_monthly"
    ) {
      if (!activeCycle) return 0;
      const fixedTotal =
        parseFloat(
          selectedRoom.waterFixedAmount || selectedRoom.water_fixed_amount || 0,
        ) || 0;
      const isPerPerson =
        (selectedRoom.waterFixedType || selectedRoom.water_fixed_type) ===
        "per_person";
      if (isPerPerson) return fixedTotal;
      return r2(fixedTotal / payorCount);
    }
    let nonPayorWater = 0;
    selectedRoom.members.forEach((member) => {
      if (!member.isPayer) {
        nonPayorWater +=
          getFilteredPresence(member.id || member._id).length *
          WATER_BILL_PER_DAY;
      }
    });
    const ownWater = getFilteredPresence(memberId).length * WATER_BILL_PER_DAY;
    const sharedNonPayorWater =
      payorCount > 0 ? r2(nonPayorWater / payorCount) : 0;
    return r2(ownWater + sharedNonPayorWater);
  };

  const getWaterShareBreakdown = () => {
    if (!selectedRoom?.members || !userId) return null;
    const currentUserMember = selectedRoom.members.find(
      (m) => String(m.user?.id || m.user?._id || m.user) === String(userId),
    );
    if (!currentUserMember?.isPayer) return null;

    if (activeCycle?.memberCharges?.length > 0) {
      const userCharge = findUserCharge(activeCycle.memberCharges, userId);
      if (userCharge && (userCharge.isPayer || userCharge.is_payer)) {
        const payorCount =
          activeCycle.memberCharges.filter((c) => c.isPayer || c.is_payer)
            .length || 1;
        const waterOwn = userCharge.waterOwn || userCharge.water_own || 0;
        const waterSharedNonpayor =
          userCharge.waterSharedNonpayor ||
          userCharge.water_shared_nonpayor ||
          0;
        return {
          ownWater: waterOwn,
          nonPayorWater: waterSharedNonpayor * payorCount,
          sharedNonPayorWater: waterSharedNonpayor,
          payorCount,
          totalWaterShare:
            userCharge.waterBillShare ||
            userCharge.water_bill_share ||
            r2(waterOwn + waterSharedNonpayor),
        };
      }
    }
    const payorCount =
      selectedRoom.members.filter((m) => m.isPayer).length || 1;
    const ownWater =
      getFilteredPresence(currentUserMember.id || currentUserMember._id)
        .length * WATER_BILL_PER_DAY;
    let nonPayorWater = 0;
    selectedRoom.members.forEach((member) => {
      if (!member.isPayer)
        nonPayorWater +=
          getFilteredPresence(member.id || member._id).length *
          WATER_BILL_PER_DAY;
    });
    const sharedNonPayorWater =
      payorCount > 0 ? r2(nonPayorWater / payorCount) : 0;
    return {
      ownWater,
      nonPayorWater,
      sharedNonPayorWater,
      payorCount,
      totalWaterShare: r2(ownWater + sharedNonPayorWater),
    };
  };

  const getMemberUserId = (member) =>
    String(
      member?.user?.id ||
        member?.user?._id ||
        member?.user ||
        member?.userId ||
        member?.user_id ||
        "",
    );

  const getNonPayorWaterContributions = () => {
    if (!selectedRoom?.members || !userId) return [];

    const members = selectedRoom.members;
    const payorIds = members
      .filter((member) => member.isPayer)
      .map(getMemberUserId)
      .filter(Boolean);
    const validPayorIds = new Set(payorIds);
    const currentUserId = String(userId);
    const isFixedWater =
      selectedRoom.waterBillingMode === "fixed_monthly" ||
      selectedRoom.water_billing_mode === "fixed_monthly";
    const isPerPersonWater =
      (selectedRoom.waterFixedType || selectedRoom.water_fixed_type) ===
      "per_person";
    const fixedWaterAmount =
      parseFloat(
        selectedRoom.waterFixedAmount || selectedRoom.water_fixed_amount || 0,
      ) || 0;

    return members
      .filter((member) => !member.isPayer)
      .map((member) => {
        const memberUserId = getMemberUserId(member);
        const preferredPayorIds = Array.isArray(
          member.waterSplitPayorIds || member.water_split_payor_ids,
        )
          ? (member.waterSplitPayorIds || member.water_split_payor_ids).map(
              String,
            )
          : [];
        const usesSpecificPayors =
          (member.waterSplitMode || member.water_split_mode) ===
            "specific_payors" && preferredPayorIds.length > 0;
        const splitPayorIds = usesSpecificPayors
          ? [...new Set(preferredPayorIds)].filter((id) =>
              validPayorIds.has(id),
            )
          : payorIds;
        const effectivePayorIds =
          splitPayorIds.length > 0 ? splitPayorIds : payorIds;
        const mySplitIndex = effectivePayorIds.indexOf(currentUserId);

        if (mySplitIndex === -1 || effectivePayorIds.length === 0) return null;

        const userCharge = findUserCharge(
          activeCycle?.memberCharges || [],
          memberUserId,
        );
        const presenceDays = getFilteredPresence(
          member.id || member._id,
        ).length;
        const memberWaterTotal = r2(
          Number(userCharge?.waterOwn ?? userCharge?.water_own) ||
            (isFixedWater && isPerPersonWater
              ? fixedWaterAmount
              : isFixedWater
                ? 0
                : presenceDays * WATER_BILL_PER_DAY),
        );

        if (memberWaterTotal <= 0) return null;

        const baseShare = r2(memberWaterTotal / effectivePayorIds.length);
        const assignedBeforeMe = r2(baseShare * mySplitIndex);
        const amount =
          mySplitIndex === effectivePayorIds.length - 1
            ? r2(memberWaterTotal - assignedBeforeMe)
            : baseShare;

        return {
          id: member.id || member._id || memberUserId,
          name: member.user?.name || member.name || "Non-payor",
          amount,
          presenceDays,
          memberWaterTotal,
          splitWithCount: effectivePayorIds.length,
          usesSpecificPayors,
        };
      })
      .filter(Boolean);
  };

  const isPaymentAllowed = () => {
    if (activeCycle?.status === "completed") return false;
    if (activeCycle?.status === "closed") return true;
    return (
      activeCycle?.paymentGatewayOpen === true ||
      activeCycle?.payment_gateway_open === true
    );
  };

  const getFormattedEndDate = () => {
    if (!selectedRoom?.billing?.end) return "";
    return new Date(selectedRoom.billing.end).toLocaleDateString("en-US", {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  };

  const hasNewActiveCycle = () => {
    if (activeCycle?.status !== "closed") return false;
    return !!selectedRoom?.currentCycleId;
  };

  const getCustomChargeIcon = (chargeName) => {
    const name = chargeName?.toLowerCase() || "";
    if (name.includes("maintenance")) return "home-repair-service";
    if (name.includes("groceries") || name.includes("grocery"))
      return "local-grocery-store";
    if (name.includes("cleaning") || name.includes("housekeeping"))
      return "cleaning-services";
    if (name.includes("parking")) return "local-parking";
    if (name.includes("pet") || name.includes("pets")) return "pets";
    if (name.includes("laundry")) return "local-laundry-service";
    return "add-home";
  };

  const getDaysInMonth = (date) =>
    new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  const getFirstDayOfMonth = (date) =>
    new Date(Date.UTC(date.getFullYear(), date.getMonth(), 1)).getUTCDay();
  const formatToYMD = (date) => {
    if (!date) return null;
    const d = new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };

  const generateCalendarDays = () => {
    const presenceYear = presenceMonth.getFullYear();
    const currentMonth = presenceMonth.getMonth();
    const daysInMonth = getDaysInMonth(presenceMonth);
    const firstDay = getFirstDayOfMonth(presenceMonth);
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let day = 1; day <= daysInMonth; day++)
      days.push(new Date(presenceYear, currentMonth, day));
    while (days.length < 42) days.push(null);
    return days;
  };

  const canGoToPreviousMonth = () => {
    if (!selectedRoom?.billing?.start) return false;
    const bStart = new Date(selectedRoom.billing.start);
    const pMonth = new Date(
      presenceMonth.getFullYear(),
      presenceMonth.getMonth() - 1,
      1,
    );
    return pMonth >= new Date(bStart.getFullYear(), bStart.getMonth(), 1);
  };

  const canGoToNextMonth = () => {
    if (!selectedRoom?.billing?.end) return false;
    const bEnd = new Date(selectedRoom.billing.end);
    const nMonth = new Date(
      presenceMonth.getFullYear(),
      presenceMonth.getMonth() + 1,
      1,
    );
    return nMonth <= new Date(bEnd.getFullYear(), bEnd.getMonth(), 1);
  };

  const isDateMarked = (date) => {
    if (!date || !selectedMemberPresence) return false;
    const dateStr = formatToYMD(date);
    return selectedMemberPresence.dates.some((d) => formatToYMD(d) === dateStr);
  };

  if (loading) {
    return (
      <View style={styles.centerContainer}>
        <View style={styles.centerLoader}>
          <HomeSpaceLoader />
        </View>
      </View>
    );
  }

  const fmt = (v) =>
    `₱${(v || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const currentUserMember = selectedRoom?.members?.find(
    (m) => String(m.user?.id || m.user?._id || m.user) === String(userId),
  );
  const billShare = billingDataLoading ? null : calculateBillShare();
  const billing = selectedRoom?.billing || {};
  const isUserPayor = currentUserMember?.isPayer || false;
  const previousReading =
    billing.previousReading ??
    activeCycle?.previousMeterReading ??
    activeCycle?.previous_meter_reading ??
    null;
  const currentReading =
    billing.currentReading ??
    activeCycle?.currentMeterReading ??
    activeCycle?.current_meter_reading ??
    null;
  const currentPaymentStatus = billingDataLoading
    ? null
    : getUserPaymentStatus();
  const allBillsPaid = !billingDataLoading && hasUserPaidAllBills();
  const remainingDue = billingDataLoading ? 0 : getRemainingDue();
  const totalMembers = selectedRoom?.members?.length || 0;
  const totalPayors =
    selectedRoom?.members?.filter((member) => member.isPayer).length || 0;
  const totalWaterBill = billingDataLoading ? 0 : calculateTotalWaterBill();
  const customChargesTotal = r2(
    billingDataLoading
      ? 0
      : (activeCycle?.customCharges || []).reduce(
          (sum, charge) => sum + parseFloat(charge.amount || 0),
          0,
        ),
  );
  const totalRoomBills = r2(
    (billing.rent || 0) +
      (billing.electricity || 0) +
      totalWaterBill +
      (billing.internet || 0) +
      customChargesTotal,
  );
  const billingDays =
    billing.start && billing.end
      ? Math.max(
          1,
          Math.floor(
            (new Date(billing.end) - new Date(billing.start)) /
              (1000 * 60 * 60 * 24),
          ) + 1,
        )
      : 0;
  const hasPendingSubmission =
    userPendingPayment?.status === "submitted" &&
    userPendingPayment.billing_cycle_start === activeCycle?.start_date;
  const isCycleClosed = selectedRoom?.cycleStatus === "cycle_closed";
  const paymentStateLabel = billingDataLoading
    ? "Syncing"
    : !isUserPayor
      ? "View only"
      : hasPendingSubmission
        ? "Under review"
        : isPaymentAllowed()
          ? "Open now"
          : "Host locked";
  const cycleStatusMeta = billingDataLoading
    ? {
        label: "Syncing",
        backgroundColor: colors.cardAlt,
        color: colors.textSecondary,
      }
    : !billing.start || !billing.end
      ? {
          label: "Waiting",
          backgroundColor: colors.cardAlt,
          color: colors.textSecondary,
        }
      : allBillsPaid
        ? {
            label: "Settled",
            backgroundColor: colors.successBg,
            color: colors.success,
          }
        : hasPendingSubmission
          ? {
              label: "Pending",
              backgroundColor: colors.warningBg,
              color: colors.warning,
            }
          : isCycleClosed
            ? {
                label: "Closed",
                backgroundColor: colors.errorBg,
                color: colors.error,
              }
            : {
                label: "Active",
                backgroundColor: colors.accentSurface,
                color: colors.accent,
              };
  const roleMeta = isUserPayor
    ? {
        label: "Payor",
        backgroundColor: colors.accentSurface,
        color: colors.accent,
      }
    : {
        label: "Viewer",
        backgroundColor: colors.infoBg,
        color: colors.info,
      };
  const summaryTitle = isUserPayor ? "Amount left this cycle" : "Room billing";
  const summaryPrimaryValue = isUserPayor
    ? fmt(remainingDue)
    : allBillsPaid
      ? "Settled"
      : "View only";
  const summaryDescription = billingDataLoading
    ? "Loading the latest billing amounts for this room."
    : isUserPayor
      ? hasPendingSubmission
        ? "Your latest payment has been submitted and is waiting for host verification."
        : isPaymentAllowed()
          ? "Your billing window is open. You can settle the remaining balance now."
          : "Waiting for your host to open the payment gateway after charges are finalized."
      : "You can review totals here while the assigned payors handle payment.";
  const summaryStats = [
    { label: "Members", value: totalMembers || "--" },
    { label: "Payors", value: totalPayors || "--" },
    { label: "Period", value: billingDays ? `${billingDays}d` : "--" },
    { label: "Payment", value: paymentStateLabel },
  ];
  const totalBillItems = [
    {
      label: "Rent",
      value: billing.rent || 0,
      icon: "house",
      accentBg: colors.accentSurface,
      accentColor: colors.accent,
    },
    {
      label: "Electricity",
      value: billing.electricity || 0,
      icon: "flash-on",
      accentBg: colors.warningBg,
      accentColor: colors.electricityColor,
    },
    {
      label: "Water",
      value: totalWaterBill,
      icon: "water-drop",
      accentBg: colors.infoBg,
      accentColor: colors.waterColor,
    },
    {
      label: "Internet",
      value: billing.internet || 0,
      icon: "wifi",
      accentBg: colors.accentLight,
      accentColor: colors.internetColor,
    },
  ];

  if (customChargesTotal > 0) {
    totalBillItems.push({
      label: "Extras",
      value: customChargesTotal,
      icon: "receipt-long",
      accentBg: colors.cardAlt,
      accentColor: colors.textSecondary,
    });
  }

  const waterNote =
    selectedRoom?.waterBillingMode === "fixed_monthly" ||
    selectedRoom?.water_billing_mode === "fixed_monthly"
      ? "Fixed monthly water setup"
      : "Based on attendance this cycle";
  const shareItems =
    !billShare || !isUserPayor
      ? []
      : [
          {
            label: "Rent",
            value: billShare.rent,
            icon: "house",
            color: colors.accent,
            note: totalPayors ? `Split among ${totalPayors} payor(s)` : null,
            status: currentPaymentStatus?.rentStatus || "unpaid",
          },
          {
            label: "Electricity",
            value: billShare.electricity,
            icon: "flash-on",
            color: colors.electricityColor,
            note: totalPayors ? `Split among ${totalPayors} payor(s)` : null,
            status: currentPaymentStatus?.electricityStatus || "unpaid",
          },
          {
            label: "Internet",
            value: billShare.internet,
            icon: "wifi",
            color: colors.internetColor,
            note: totalPayors ? `Split among ${totalPayors} payor(s)` : null,
            status: currentPaymentStatus?.internetStatus || "unpaid",
          },
          {
            label: "Water",
            value: billShare.water,
            icon: "water-drop",
            color: colors.waterColor,
            note: waterNote,
            status: currentPaymentStatus?.waterStatus || "unpaid",
          },
        ];

  if (billShare?.customCharges > 0) {
    const customChargeCount = activeCycle?.customCharges?.length || 0;
    shareItems.push({
      label: customChargeCount > 0 ? "Custom charges" : "Additional adjustment",
      value: billShare.customCharges,
      icon: activeCycle?.customCharges?.[0]?.name
        ? getCustomChargeIcon(activeCycle.customCharges[0].name)
        : "receipt-long",
      color: colors.textSecondary,
      note:
        customChargeCount > 0
          ? `${customChargeCount} extra charge(s) this cycle`
          : "Redistributed room bill adjustment",
      status: currentPaymentStatus?.customChargesStatus || "unpaid",
    });
  }

  const waterShareBreakdown = getWaterShareBreakdown();
  const nonPayorWaterContributions = getNonPayorWaterContributions();

  return (
    <View style={styles.container}>
      <Toast
        visible={toast.visible}
        type={toast.type}
        message={toast.message}
        onHide={() => setToast((t) => ({ ...t, visible: false }))}
      />
      <Modal
        visible={showNonPayorWaterModal}
        transparent
        animationType="fade"
        onRequestClose={() => setShowNonPayorWaterModal(false)}
      >
        <View style={styles.waterModalOverlay}>
          <View style={styles.waterModalCard}>
            <View style={styles.waterModalHeader}>
              <View style={styles.waterModalTitleWrap}>
                <View style={styles.waterModalIcon}>
                  <MaterialIcons
                    name="water-drop"
                    size={20}
                    color={colors.waterColor}
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Text style={styles.waterModalTitle}>Shared water</Text>
                  <Text style={styles.waterModalSubtitle}>
                    Non-payors assigned to your share
                  </Text>
                </View>
              </View>
              <TouchableOpacity
                style={styles.waterModalClose}
                onPress={() => setShowNonPayorWaterModal(false)}
                activeOpacity={0.75}
              >
                <MaterialIcons name="close" size={20} color={colors.text} />
              </TouchableOpacity>
            </View>

            <View style={styles.waterModalTotalRow}>
              <Text style={styles.waterModalTotalLabel}>
                Your shared portion
              </Text>
              <Text style={styles.waterModalTotalAmount}>
                {fmt(waterShareBreakdown?.sharedNonPayorWater || 0)}
              </Text>
            </View>

            {nonPayorWaterContributions.length > 0 ? (
              <ScrollView
                style={styles.waterModalList}
                showsVerticalScrollIndicator={false}
              >
                {nonPayorWaterContributions.map((item) => (
                  <View key={item.id} style={styles.waterModalPersonRow}>
                    <View style={styles.waterModalAvatar}>
                      <Text style={styles.waterModalAvatarText}>
                        {item.name.charAt(0).toUpperCase()}
                      </Text>
                    </View>
                    <View style={{ flex: 1 }}>
                      <Text style={styles.waterModalPersonName}>
                        {item.name}
                      </Text>
                      <Text style={styles.waterModalPersonMeta}>
                        {item.presenceDays} day
                        {item.presenceDays !== 1 ? "s" : ""} water total{" "}
                        {fmt(item.memberWaterTotal)} split with{" "}
                        {item.splitWithCount} payor
                        {item.splitWithCount !== 1 ? "s" : ""} -{" "}
                        {item.usesSpecificPayors
                          ? "selected you"
                          : "all payors"}
                      </Text>
                    </View>
                    <Text style={styles.waterModalPersonAmount}>
                      {fmt(item.amount)}
                    </Text>
                  </View>
                ))}
              </ScrollView>
            ) : (
              <View style={styles.waterModalEmpty}>
                <Text style={styles.waterModalEmptyTitle}>
                  No non-payor split details
                </Text>
                <Text style={styles.waterModalEmptyText}>
                  There are no non-payor water amounts assigned to you in this
                  cycle.
                </Text>
              </View>
            )}
          </View>
        </View>
      </Modal>
      <ScrollViewWithDetection
        style={{ flex: 1 }}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            colors={[colors.accent]}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* ─── HEADER ─── */}
        <View style={styles.header}>
          <View style={styles.headerContent}>
            <View style={styles.headerTitleRow}>
              <View style={styles.headerIconBg}>
                <MaterialIcons name="receipt-long" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Bills & Payments</Text>
                <Text style={styles.headerSubtitle}>
                  {selectedRoom ? selectedRoom.name : "Select a room to view"}
                </Text>
              </View>
            </View>
            <Text style={styles.headerFootnote}>
              Track the cycle, review the breakdown, and settle balances from
              one place.
            </Text>
          </View>
        </View>

        {/* ─── ROOM SELECTOR ─── */}
        {rooms.length > 0 && (
          <View style={styles.roomSelectorContainer}>
            <ScrollViewWithDetection
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, gap: 10 }}
            >
              {rooms.map((room) => {
                const isActive =
                  (selectedRoom?.id || selectedRoom?._id) ===
                  (room.id || room._id);
                return (
                  <TouchableOpacity
                    key={room.id || room._id}
                    style={[styles.roomPill, isActive && styles.roomPillActive]}
                    onPress={() => {
                      if (isActive) return;
                      setBillingDataLoading(true);
                      setSelectedRoom(room);
                      extractMemberPresence(room);
                    }}
                    activeOpacity={0.7}
                  >
                    <View
                      style={[
                        styles.roomPillDot,
                        isActive && styles.roomPillDotActive,
                      ]}
                    />
                    <Text
                      style={[
                        styles.roomPillText,
                        isActive && styles.roomPillTextActive,
                      ]}
                    >
                      {room.name}
                    </Text>
                  </TouchableOpacity>
                );
              })}
            </ScrollViewWithDetection>
          </View>
        )}

        {/* ─── EMPTY STATE ─── */}
        {!loading && rooms.length === 0 && (
          <View style={styles.emptyStateContainer}>
            <View style={styles.emptyStateIconBg}>
              <MaterialIcons
                name="meeting-room"
                size={40}
                color={colors.accent}
              />
            </View>
            <Text style={styles.emptyStateTitle}>No room yet</Text>
            <Text style={styles.emptyStateSubtext}>
              You haven't joined a room. Once you're added to one, your bills
              and payment history will appear here.
            </Text>
            <TouchableOpacity
              style={styles.emptyStateCta}
              onPress={() =>
                navigation.navigate("RoomsStack", { screen: "RoomsMain" })
              }
              activeOpacity={0.8}
            >
              <MaterialIcons name="add" size={18} color="#fff" />
              <Text style={styles.emptyStateCtaText}>Browse rooms</Text>
            </TouchableOpacity>
          </View>
        )}

        {selectedRoom && (
          <View style={styles.contentPadding}>
            <View style={styles.summaryCard}>
              <View style={styles.summaryTopRow}>
                <View style={styles.summaryCopy}>
                  <Text style={styles.summaryEyebrow}>Current snapshot</Text>
                  <Text style={styles.summaryTitle}>{summaryTitle}</Text>
                  {billingDataLoading ? (
                    <AmountSkeleton
                      colors={colors}
                      style={styles.summaryValueSkeleton}
                    />
                  ) : (
                    <Text style={styles.summaryPrimaryValue}>
                      {summaryPrimaryValue}
                    </Text>
                  )}
                  <Text style={styles.summarySubtext}>
                    {summaryDescription}
                  </Text>
                </View>
                <View style={styles.summaryBadgeStack}>
                  <View
                    style={[
                      styles.summaryBadge,
                      { backgroundColor: roleMeta.backgroundColor },
                    ]}
                  >
                    <Text
                      style={[
                        styles.summaryBadgeText,
                        { color: roleMeta.color },
                      ]}
                    >
                      {roleMeta.label}
                    </Text>
                  </View>
                  <View
                    style={[
                      styles.summaryBadge,
                      { backgroundColor: cycleStatusMeta.backgroundColor },
                    ]}
                  >
                    <Text
                      style={[
                        styles.summaryBadgeText,
                        { color: cycleStatusMeta.color },
                      ]}
                    >
                      {cycleStatusMeta.label}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.summaryStatsRow}>
                {summaryStats.map((stat) => (
                  <View key={stat.label} style={styles.summaryStatCard}>
                    <Text style={styles.summaryStatValue}>{stat.value}</Text>
                    <Text style={styles.summaryStatLabel}>{stat.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </View>
        )}

        {/* No room selected prompt */}
        {!selectedRoom && rooms.length > 0 && (
          <View style={styles.contentPadding}>
            <View style={styles.promptCard}>
              <View style={styles.promptIconCircle}>
                <MaterialIcons
                  name="touch-app"
                  size={32}
                  color={colors.accent}
                />
              </View>
              <Text style={styles.promptTitle}>Select a Room</Text>
              <Text style={styles.promptSubtext}>
                Choose a room above to view your billing details
              </Text>
            </View>
          </View>
        )}

        {selectedRoom && billingDataLoading && (
          <View style={styles.contentPadding}>
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <View style={styles.cardIconBg}>
                  <ActivityIndicator size="small" color={colors.accent} />
                </View>
                <Text style={styles.cardTitle}>Loading bill amounts</Text>
              </View>
              <View style={styles.billGrid}>
                {["Rent", "Electricity", "Water", "Internet"].map((label) => (
                  <View key={label} style={styles.billGridItem}>
                    <AmountSkeleton
                      colors={colors}
                      style={styles.billIconSkeleton}
                    />
                    <Text style={styles.billGridLabel}>{label}</Text>
                    <AmountSkeleton
                      colors={colors}
                      style={styles.billAmountSkeleton}
                    />
                  </View>
                ))}
              </View>
              <View style={styles.grandTotalStrip}>
                <Text style={styles.grandTotalLabel}>Room Total</Text>
                <AmountSkeleton
                  colors={colors}
                  style={styles.totalAmountSkeleton}
                />
              </View>
            </View>

            {isUserPayor && (
              <View style={styles.card}>
                <View style={styles.cardHeader}>
                  <View style={styles.cardIconBg}>
                    <ActivityIndicator size="small" color={colors.accent} />
                  </View>
                  <Text style={styles.cardTitle}>Preparing your share</Text>
                </View>
                <View style={styles.shareList}>
                  {["Rent", "Electricity", "Water"].map((label) => (
                    <View key={label} style={styles.shareItem}>
                      <View style={styles.shareItemLeft}>
                        <AmountSkeleton
                          colors={colors}
                          style={styles.shareIconSkeleton}
                        />
                        <View style={styles.shareItemTextWrap}>
                          <Text style={styles.shareItemLabel}>{label}</Text>
                          <AmountSkeleton
                            colors={colors}
                            style={styles.shareNoteSkeleton}
                          />
                        </View>
                      </View>
                      <AmountSkeleton
                        colors={colors}
                        style={styles.shareAmountSkeleton}
                      />
                    </View>
                  ))}
                </View>
              </View>
            )}
          </View>
        )}

        {selectedRoom && !billingDataLoading && (
          <>
            {/* ─── OUTSTANDING BALANCE BANNER ─── */}
            {isUserPayor && outstandingBalance.totalOutstanding > 0 && (
              <View style={styles.contentPadding}>
                <View style={styles.outstandingCard}>
                  <View style={styles.outstandingCardHeader}>
                    <MaterialIcons
                      name="warning"
                      size={22}
                      color={colors.error}
                    />
                    <Text style={styles.outstandingCardTitle}>
                      Outstanding Balance
                    </Text>
                    <Text style={styles.outstandingCardTotal}>
                      {fmt(outstandingBalance.totalOutstanding)}
                    </Text>
                  </View>
                  <Text style={styles.outstandingCardSubtitle}>
                    You have unpaid bills from{" "}
                    {outstandingBalance.unpaidCycles.length} previous billing
                    cycle(s). Please settle these with your host.
                  </Text>
                  {outstandingBalance.unpaidCycles.map((cycle, idx) => {
                    const cycleAlreadySubmitted =
                      userPendingPayment &&
                      (userPendingPayment.status === "submitted" ||
                        userPendingPayment.status === "pending") &&
                      userPendingPayment.billing_cycle_start ===
                        cycle.startDate;

                    return (
                      <View key={idx} style={styles.outstandingCycleRow}>
                        <View style={{ flex: 1 }}>
                          <Text style={styles.outstandingCycleLabel}>
                            Cycle #{cycle.cycleNumber}
                          </Text>
                          <Text style={styles.outstandingCyclePeriod}>
                            {new Date(cycle.startDate).toLocaleDateString(
                              "en-US",
                              { month: "short", day: "numeric" },
                            )}{" "}
                            –{" "}
                            {new Date(cycle.endDate).toLocaleDateString(
                              "en-US",
                              {
                                month: "short",
                                day: "numeric",
                                year: "numeric",
                              },
                            )}
                          </Text>
                        </View>
                        <View style={{ alignItems: "flex-end", gap: 6 }}>
                          <Text style={styles.outstandingCycleAmount}>
                            {fmt(cycle.totalDue)}
                          </Text>
                          {cycleAlreadySubmitted ? (
                            <View style={styles.outstandingPendingBadge}>
                              <MaterialIcons
                                name="hourglass-top"
                                size={12}
                                color={colors.warning}
                              />
                              <Text style={styles.outstandingPendingBadgeText}>
                                Awaiting Verification
                              </Text>
                            </View>
                          ) : (
                            <TouchableOpacity
                              style={styles.outstandingPayButton}
                              onPress={() => {
                                if (selectedRoom) {
                                  navigation.navigate("PaymentMethod", {
                                    roomId: selectedRoom.id || selectedRoom._id,
                                    roomName: selectedRoom.name,
                                    amount: cycle.totalDue,
                                    billType: "total",
                                    billingCycleId: cycle.cycleId,
                                  });
                                }
                              }}
                              activeOpacity={0.8}
                            >
                              <MaterialIcons
                                name="payment"
                                size={16}
                                color={colors.textOnAccent}
                              />
                              <Text style={styles.outstandingPayButtonText}>
                                Pay
                              </Text>
                            </TouchableOpacity>
                          )}
                        </View>
                      </View>
                    );
                  })}
                </View>
              </View>
            )}

            {billing?.start && billing?.end && !allBillsPaid ? (
              <View style={styles.contentPadding}>
                {/* ─── CYCLE CLOSED WARNING ─── */}
                {isUserPayor &&
                  selectedRoom?.cycleStatus === "cycle_closed" && (
                    <View style={styles.warningCard}>
                      <MaterialIcons
                        name="warning"
                        size={24}
                        color={colors.warning}
                      />
                      <View style={{ flex: 1 }}>
                        <Text style={styles.warningCardTitle}>
                          Billing Cycle Closed
                        </Text>
                        <Text style={styles.warningCardText}>
                          This billing cycle has been closed by your host.
                          Please settle your outstanding payment.
                        </Text>
                      </View>
                    </View>
                  )}

                {/* Non-Payor Notice */}
                {!isUserPayor &&
                  (() => {
                    const payors = (selectedRoom?.members || []).filter(
                      (m) => m.isPayer,
                    );
                    const allPayorsPaid =
                      payors.length > 0 &&
                      payors.every((p) => {
                        const pmt = selectedRoom.memberPayments?.find(
                          (mp) =>
                            String(mp.member) ===
                            String(p.user?.id || p.user?._id || p.user),
                        );
                        return (
                          pmt?.rentStatus === "paid" &&
                          pmt?.electricityStatus === "paid" &&
                          pmt?.waterStatus === "paid" &&
                          (pmt?.internetStatus === "paid" || !billing?.internet)
                        );
                      });

                    if (allPayorsPaid) {
                      return (
                        <View
                          style={[
                            styles.nonPayorCard,
                            styles.nonPayorCardSuccess,
                          ]}
                        >
                          <MaterialIcons
                            name="check-circle"
                            size={24}
                            color={colors.success}
                          />
                          <View style={{ flex: 1, marginLeft: 12 }}>
                            <Text
                              style={[
                                styles.nonPayorText,
                                styles.nonPayorTextSuccess,
                              ]}
                            >
                              Billing cycle complete!
                            </Text>
                            <Text style={styles.nonPayorSubtext}>
                              All payors in your room have settled their bills.
                              Please wait for the host to start a new billing
                              period.
                            </Text>
                          </View>
                        </View>
                      );
                    }

                    return (
                      <View style={styles.nonPayorCard}>
                        <MaterialIcons
                          name="info-outline"
                          size={24}
                          color={colors.info}
                        />
                        <View style={{ flex: 1, marginLeft: 12 }}>
                          <Text style={styles.nonPayorText}>
                            You are not a payor for this room
                          </Text>
                          <Text style={styles.nonPayorSubtext}>
                            The payors in your room handle the bill payments.
                            You can view the billing summary above.
                          </Text>
                        </View>
                      </View>
                    );
                  })()}

                {/* ─── BILLING PERIOD CARD ─── */}
                <View style={styles.card}>
                  <View style={styles.cardHeader}>
                    <View style={styles.cardIconBg}>
                      <Ionicons
                        name="calendar"
                        size={18}
                        color={colors.accent}
                      />
                    </View>
                    <Text style={styles.cardTitle}>Billing Period</Text>
                  </View>
                  <View style={styles.periodRow}>
                    <View style={styles.periodBlock}>
                      <Text style={styles.periodBlockLabel}>Start</Text>
                      <Text style={styles.periodBlockDate}>
                        {new Date(billing.start).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </Text>
                      <Text style={styles.periodBlockYear}>
                        {new Date(billing.start).getFullYear()}
                      </Text>
                    </View>
                    <View style={styles.periodArrow}>
                      <MaterialIcons
                        name="arrow-forward"
                        size={24}
                        color={colors.border}
                      />
                    </View>
                    <View style={styles.periodBlock}>
                      <Text style={styles.periodBlockLabel}>End</Text>
                      <Text style={styles.periodBlockDate}>
                        {new Date(billing.end).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                        })}
                      </Text>
                      <Text style={styles.periodBlockYear}>
                        {new Date(billing.end).getFullYear()}
                      </Text>
                    </View>
                  </View>
                  <View style={styles.periodMetaRow}>
                    <View style={styles.periodMetaPill}>
                      <MaterialIcons
                        name="schedule"
                        size={14}
                        color={colors.textSecondary}
                      />
                      <Text style={styles.periodMetaPillText}>
                        {billingDays} day cycle
                      </Text>
                    </View>
                    <View style={styles.periodMetaPill}>
                      <MaterialIcons
                        name="people-alt"
                        size={14}
                        color={colors.textSecondary}
                      />
                      <Text style={styles.periodMetaPillText}>
                        {totalPayors}/{Math.max(totalMembers, 1)} payors
                      </Text>
                    </View>
                    {(previousReading !== null || currentReading !== null) && (
                      <View style={styles.periodMetaPill}>
                        <MaterialIcons
                          name="speed"
                          size={14}
                          color={colors.textSecondary}
                        />
                        <Text style={styles.periodMetaPillText}>
                          Meter {previousReading ?? "--"} to{" "}
                          {currentReading ?? "--"}
                        </Text>
                      </View>
                    )}
                  </View>
                </View>

                {/* ─── TOTAL BILLS OVERVIEW ─── */}
                {billing.start &&
                  billing.end &&
                  (billing.rent ||
                    billing.electricity ||
                    totalWaterBill ||
                    billing.internet ||
                    customChargesTotal) && (
                    <View style={styles.card}>
                      <View style={styles.cardHeader}>
                        <View
                          style={[
                            styles.cardIconBg,
                            { backgroundColor: colors.accentSurface },
                          ]}
                        >
                          <MaterialIcons
                            name="assessment"
                            size={18}
                            color={colors.accent}
                          />
                        </View>
                        <Text style={styles.cardTitle}>Total Bills</Text>
                      </View>
                      <Text style={styles.cardCaption}>
                        Full room totals for this billing period.
                      </Text>
                      <View style={styles.billGrid}>
                        {totalBillItems.map((item) => (
                          <View key={item.label} style={styles.billGridItem}>
                            <View
                              style={[
                                styles.billIconCircle,
                                { backgroundColor: item.accentBg },
                              ]}
                            >
                              <MaterialIcons
                                name={item.icon}
                                size={20}
                                color={item.accentColor}
                              />
                            </View>
                            <Text style={styles.billGridLabel}>
                              {item.label}
                            </Text>
                            <Text style={styles.billGridAmount}>
                              {fmt(item.value)}
                            </Text>
                          </View>
                        ))}
                      </View>
                      <View style={styles.grandTotalStrip}>
                        <Text style={styles.grandTotalLabel}>Room Total</Text>
                        <Text style={styles.grandTotalAmount}>
                          {fmt(totalRoomBills)}
                        </Text>
                      </View>
                    </View>
                  )}

                {/* ─── YOUR SHARE ─── */}
                {billShare && isUserPayor && (
                  <View style={styles.card}>
                    <View style={styles.cardHeader}>
                      <View
                        style={[
                          styles.cardIconBg,
                          { backgroundColor: colors.accentSurface },
                        ]}
                      >
                        <MaterialIcons
                          name="person"
                          size={18}
                          color={colors.accent}
                        />
                      </View>
                      <Text style={styles.cardTitle}>Bills to pay</Text>
                    </View>
                    <View style={styles.shareIntroRow}>
                      <View style={styles.shareIntroPill}>
                        <MaterialIcons
                          name="group"
                          size={14}
                          color={colors.accent}
                        />
                        <Text style={styles.shareIntroPillText}>
                          Split with {totalPayors || 1} payor(s)
                        </Text>
                      </View>
                      <View style={styles.shareIntroPill}>
                        <MaterialIcons
                          name="event"
                          size={14}
                          color={colors.accent}
                        />
                        <Text style={styles.shareIntroPillText}>
                          Ends {getFormattedEndDate()}
                        </Text>
                      </View>
                    </View>
                    <View style={styles.shareList}>
                      {shareItems.map((item) => (
                        <View key={item.label} style={styles.shareItem}>
                          <View style={styles.shareItemLeft}>
                            <View
                              style={[
                                styles.shareItemIconWrap,
                                { backgroundColor: `${item.color}14` },
                              ]}
                            >
                              <MaterialIcons
                                name={item.icon}
                                size={18}
                                color={item.color}
                              />
                            </View>
                            <View style={styles.shareItemTextWrap}>
                              <View style={styles.shareItemTitleRow}>
                                <Text style={styles.shareItemLabel}>
                                  {item.label}
                                </Text>
                                {item.status === "paid" && (
                                  <View style={styles.sharePaidBadge}>
                                    <Text style={styles.sharePaidBadgeText}>
                                      Paid
                                    </Text>
                                  </View>
                                )}
                              </View>
                              {item.note ? (
                                <Text style={styles.shareItemSubtext}>
                                  {item.note}
                                </Text>
                              ) : null}
                            </View>
                          </View>
                          <View style={styles.shareItemRight}>
                            <Text style={styles.shareItemValue}>
                              {fmt(item.value)}
                            </Text>
                            <Text style={styles.shareItemNote}>
                              {item.status === "paid"
                                ? "Settled"
                                : "Outstanding"}
                            </Text>
                          </View>
                        </View>
                      ))}
                    </View>
                    {waterShareBreakdown && billShare.water > 0 && (
                      <View style={styles.helperStatsRow}>
                        <View style={styles.helperStatCard}>
                          <Text style={styles.helperStatLabel}>
                            Your water portion
                          </Text>
                          <Text style={styles.helperStatValue}>
                            {fmt(waterShareBreakdown.ownWater)}
                          </Text>
                        </View>
                        <TouchableOpacity
                          style={[
                            styles.helperStatCard,
                            styles.helperStatCardPressable,
                          ]}
                          onPress={() => setShowNonPayorWaterModal(true)}
                          activeOpacity={0.78}
                        >
                          <Text style={styles.helperStatLabel}>
                            Shared from non-payors
                          </Text>
                          <View style={styles.helperStatValueRow}>
                            <Text style={styles.helperStatValue}>
                              {fmt(
                                waterShareBreakdown.sharedNonPayorWater || 0,
                              )}
                            </Text>
                            <MaterialIcons
                              name="chevron-right"
                              size={20}
                              color={colors.accent}
                            />
                          </View>
                        </TouchableOpacity>
                      </View>
                    )}
                    <View style={styles.totalDueStrip}>
                      <Text style={styles.totalDueLabel}>Total Due</Text>
                      <Text style={styles.totalDueAmount}>
                        {fmt(remainingDue)}
                      </Text>
                    </View>

                    {hasPendingSubmission ? (
                      <View
                        style={[
                          styles.paymentLockedBox,
                          styles.paymentLockedBoxWarning,
                        ]}
                      >
                        <MaterialIcons
                          name="hourglass-top"
                          size={24}
                          color={colors.warning}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.paymentLockedTextWarning}>
                            Awaiting Host Verification
                          </Text>
                          <Text style={styles.paymentLockedSubtextWarning}>
                            Your payment has been submitted.
                          </Text>
                        </View>
                      </View>
                    ) : isPaymentAllowed() ? (
                      <TouchableOpacity
                        style={[
                          styles.payNowButton,
                          activeCycle?.status === "completed" &&
                            styles.payNowButtonDisabled,
                        ]}
                        onPress={() => setShowSelectivePaymentModal(true)}
                        disabled={activeCycle?.status === "completed"}
                      >
                        <MaterialIcons name="payment" size={22} color="#fff" />
                        <Text style={styles.payNowButtonText}>Pay Now</Text>
                      </TouchableOpacity>
                    ) : (
                      <View style={styles.paymentLockedBox}>
                        <MaterialIcons
                          name="lock-clock"
                          size={24}
                          color={colors.accent}
                        />
                        <View style={{ flex: 1 }}>
                          <Text style={styles.paymentLockedText}>
                            Payment gateway closed
                          </Text>
                          <Text style={styles.paymentLockedSubtext}>
                            Your host will open payments once charges are final
                          </Text>
                        </View>
                      </View>
                    )}
                  </View>
                )}
              </View>
            ) : allBillsPaid ? (
              <View style={styles.contentPadding}>
                <View style={styles.statusCard}>
                  <View
                    style={[
                      styles.statusIconCircle,
                      { backgroundColor: colors.successBg },
                    ]}
                  >
                    <MaterialIcons
                      name="check-circle"
                      size={42}
                      color={colors.success}
                    />
                  </View>
                  <Text style={styles.statusTitle}>All Bills Paid!</Text>
                  <Text style={styles.statusSubtext}>
                    You have paid all bills for this billing period. Waiting for
                    the admin to start a new billing cycle.
                  </Text>
                </View>
              </View>
            ) : (
              <View style={styles.contentPadding}>
                <View style={styles.statusCard}>
                  <View
                    style={[
                      styles.statusIconCircle,
                      { backgroundColor: colors.accentSurface },
                    ]}
                  >
                    <MaterialIcons
                      name="hourglass-empty"
                      size={42}
                      color={colors.accent}
                    />
                  </View>
                  <Text style={styles.statusTitle}>
                    No Active Billing Cycle
                  </Text>
                  <Text style={styles.statusSubtext}>
                    Waiting for admin to set billing details
                  </Text>
                </View>
              </View>
            )}
          </>
        )}

        {/* ─── ACTION BUTTONS ─── */}
        {selectedRoom && (
          <View style={styles.actionsSection}>
            <Text style={styles.sectionLabel}>History & records</Text>
            <Text style={styles.sectionSubtext}>
              Open past billing cycles and payment activity for this room.
            </Text>
            <TouchableOpacity
              style={styles.actionCard}
              onPress={() =>
                navigation.navigate("BillingHistory", {
                  roomId: selectedRoom.id || selectedRoom._id,
                  roomName: selectedRoom.name,
                })
              }
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.actionIconBg,
                  { backgroundColor: colors.accentSurface },
                ]}
              >
                <MaterialIcons name="history" size={22} color={colors.accent} />
              </View>
              <View style={styles.actionCardBody}>
                <Text style={styles.actionCardText}>Billing History</Text>
                <Text style={styles.actionCardSubtext}>
                  Review previous cycles, totals, and settlement status.
                </Text>
              </View>
              <MaterialIcons
                name="chevron-right"
                size={24}
                color={colors.textTertiary}
              />
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionCard}
              onPress={() =>
                navigation.navigate("PaymentHistory", {
                  roomId: selectedRoom.id || selectedRoom._id,
                  roomName: selectedRoom.name,
                })
              }
              activeOpacity={0.7}
            >
              <View
                style={[
                  styles.actionIconBg,
                  { backgroundColor: colors.accentSurface },
                ]}
              >
                <MaterialIcons name="payment" size={22} color={colors.accent} />
              </View>
              <View style={styles.actionCardBody}>
                <Text style={styles.actionCardText}>Payment History</Text>
                <Text style={styles.actionCardSubtext}>
                  Check submitted payments and verification progress.
                </Text>
              </View>
              <MaterialIcons
                name="chevron-right"
                size={24}
                color={colors.textTertiary}
              />
            </TouchableOpacity>
          </View>
        )}
        <View style={{ height: 40 }} />
      </ScrollViewWithDetection>

      {/* ─── SELECTIVE PAYMENT MODAL ─── */}
      <SelectivePaymentModal
        visible={showSelectivePaymentModal}
        onClose={() => setShowSelectivePaymentModal(false)}
        onProceed={(paymentData) => {
          setShowSelectivePaymentModal(false);
          if (selectedRoom && activeCycle) {
            setCurrentPaymentBreakdown(paymentData.breakdown);
            navigation.navigate("PaymentMethod", {
              roomId: selectedRoom.id || selectedRoom._id,
              roomName: selectedRoom.name,
              amount: paymentData.amount,
              billType: paymentData.billTypes[0] || "total",
              billTypes: paymentData.billTypes,
              billingCycleId: activeCycle?.id || activeCycle?._id,
              breakdown: paymentData.breakdown,
              billAmounts: paymentData.billAmounts,
            });
          }
        }}
        billShare={billShare}
        roomName={selectedRoom?.name || "Room"}
        paymentStatus={getUserPaymentStatus()}
      />
    </View>
  );
};

const createStyles = (colors, insets = { top: 0, bottom: 0 }) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    centerContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.background,
    },
    contentPadding: {
      paddingHorizontal: 16,
    },
    // scrollContent: {
    //   paddingBottom: insets.bottom + 120,
    // },
    header: {
      paddingHorizontal: 20,
      // paddingTop: insets.top + 14,
      paddingTop: 20,
      paddingBottom: 60,
      backgroundColor: colors.headerBg,
      borderBottomLeftRadius: 32,
      borderBottomRightRadius: 32,
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
    },
    headerContent: {
      flex: 1,
    },
    headerTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    headerIconBg: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: "rgba(255,255,255,0.15)",
      justifyContent: "center",
      alignItems: "center",
    },
    headerTitle: {
      fontSize: 24,
      fontWeight: "800",
      color: "#ffffff",
      letterSpacing: -0.3,
    },
    headerSubtitle: {
      fontSize: 13,
      color: "rgba(255,255,255,0.75)",
      marginTop: 2,
    },
    headerFootnote: {
      fontSize: 12,
      color: "rgba(255,255,255,0.72)",
      marginTop: 14,
      lineHeight: 18,
      maxWidth: "88%",
    },
    exportButton: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: "rgba(255,255,255,0.15)",
      justifyContent: "center",
      alignItems: "center",
    },
    roomSelectorContainer: {
      paddingVertical: 14,
      marginHorizontal: 16,
      marginTop: -30,
      backgroundColor: colors.card,
      borderRadius: 20,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 12,
      elevation: 6,
    },
    roomPill: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 20,
      backgroundColor: colors.cardAlt,
      borderWidth: 1,
      borderColor: colors.borderLight,
      gap: 8,
    },
    roomPillActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    roomPillDot: {
      width: 6,
      height: 6,
      borderRadius: 3,
      backgroundColor: colors.textTertiary,
    },
    roomPillDotActive: {
      backgroundColor: colors.textOnAccent,
    },
    roomPillText: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    roomPillTextActive: {
      color: colors.textOnAccent,
    },
    summaryCard: {
      marginTop: 18,
      backgroundColor: colors.card,
      borderRadius: 24,
      padding: 18,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 6 },
      shadowOpacity: 0.1,
      shadowRadius: 18,
      elevation: 4,
    },
    summaryTopRow: {
      flexDirection: "row",
      gap: 16,
      alignItems: "flex-start",
    },
    summaryCopy: {
      flex: 1,
    },
    summaryEyebrow: {
      fontSize: 11,
      fontWeight: "800",
      color: colors.accent,
      textTransform: "uppercase",
      letterSpacing: 0.8,
      marginBottom: 8,
    },
    summaryTitle: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
      letterSpacing: -0.2,
    },
    summaryPrimaryValue: {
      fontSize: 31,
      fontWeight: "900",
      color: colors.text,
      letterSpacing: -1,
      marginTop: 8,
    },
    summaryValueSkeleton: {
      width: 170,
      height: 36,
      marginTop: 10,
      marginBottom: 2,
    },
    summarySubtext: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 19,
      marginTop: 10,
    },
    summaryBadgeStack: {
      gap: 8,
      alignItems: "flex-end",
    },
    summaryBadge: {
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    summaryBadgeText: {
      fontSize: 11,
      fontWeight: "800",
      letterSpacing: 0.3,
      textTransform: "uppercase",
    },
    summaryStatsRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      marginTop: 18,
    },
    summaryStatCard: {
      width: "47%",
      flexGrow: 1,
      backgroundColor: colors.cardAlt,
      borderRadius: 18,
      paddingHorizontal: 14,
      paddingVertical: 14,
    },
    summaryStatValue: {
      fontSize: 18,
      fontWeight: "900",
      color: colors.text,
      letterSpacing: -0.4,
    },
    summaryStatLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textTertiary,
      marginTop: 5,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    promptCard: {
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: 30,
      marginTop: 20,
      alignItems: "center",
      shadowColor: "#555",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    promptIconCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.infoBg,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 16,
    },
    promptTitle: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.text,
    },
    promptSubtext: {
      fontSize: 14,
      color: colors.textTertiary,
      marginTop: 8,
      textAlign: "center",
      lineHeight: 20,
    },
    card: {
      backgroundColor: colors.card,
      borderRadius: 20,
      marginTop: 20,
      overflow: "hidden",
      shadowColor: "#555",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 18,
      paddingTop: 18,
      paddingBottom: 18,
      gap: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    cardIconBg: {
      width: 38,
      height: 38,
      borderRadius: 12,
      backgroundColor: colors.accentSurface,
      justifyContent: "center",
      alignItems: "center",
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
      flex: 1,
    },
    cardCaption: {
      fontSize: 13,
      color: colors.textTertiary,
      lineHeight: 18,
      paddingHorizontal: 18,
      paddingTop: 10,
    },
    outstandingCard: {
      backgroundColor: colors.errorBg,
      borderRadius: 20,
      padding: 18,
      borderWidth: 1.5,
      borderColor: colors.error,
      marginTop: 16,
    },
    outstandingCardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginBottom: 10,
    },
    outstandingCardTitle: {
      flex: 1,
      fontSize: 16,
      fontWeight: "800",
      color: colors.error,
    },
    outstandingCardTotal: {
      fontSize: 20,
      fontWeight: "900",
      color: colors.error,
    },
    outstandingCardSubtitle: {
      fontSize: 13,
      color: colors.textSecondary,
      marginBottom: 12,
      lineHeight: 18,
    },
    outstandingCycleRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingVertical: 10,
      borderTopWidth: 1,
      borderTopColor: "#ef9a9a",
    },
    outstandingCycleLabel: {
      fontSize: 14,
      fontWeight: "700",
      color: colors.error,
    },
    outstandingCyclePeriod: {
      fontSize: 12,
      color: colors.textSecondary,
      marginTop: 2,
    },
    outstandingCycleAmount: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.error,
    },
    outstandingPendingBadge: {
      backgroundColor: colors.warningBg,
      borderRadius: 999,
      paddingHorizontal: 10,
      paddingVertical: 5,
      borderWidth: 1,
      borderColor: colors.warning,
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
    },
    outstandingPendingBadgeText: {
      color: colors.warning,
      fontSize: 11,
      fontWeight: "700",
    },
    outstandingPayButton: {
      backgroundColor: colors.error,
      borderRadius: 10,
      paddingHorizontal: 16,
      paddingVertical: 8,
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
    },
    outstandingPayButtonText: {
      color: colors.textOnAccent,
      fontSize: 13,
      fontWeight: "700",
    },
    nonPayorCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.infoBg,
      borderRadius: 16,
      padding: 16,
      marginTop: 16,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    nonPayorText: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.info,
    },
    nonPayorSubtext: {
      fontSize: 13,
      color: colors.textSecondary,
      marginTop: 4,
      lineHeight: 18,
    },
    nonPayorCardSuccess: {
      backgroundColor: colors.successBg,
      borderColor: colors.success,
    },
    nonPayorTextSuccess: {
      color: colors.success,
    },
    warningCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.warningBg,
      borderWidth: 1,
      borderColor: colors.warning,
      borderRadius: 16,
      padding: 16,
      marginTop: 16,
      gap: 12,
    },
    warningCardTitle: {
      color: colors.warning,
      fontWeight: "800",
      fontSize: 15,
    },
    warningCardText: {
      color: colors.textSecondary,
      fontSize: 13,
      marginTop: 2,
      lineHeight: 18,
    },
    statusCard: {
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: 32,
      marginTop: 20,
      alignItems: "center",
      shadowColor: "#555",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    statusIconCircle: {
      width: 72,
      height: 72,
      borderRadius: 36,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 16,
    },
    statusTitle: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.text,
    },
    statusSubtext: {
      fontSize: 14,
      color: colors.textTertiary,
      marginTop: 8,
      textAlign: "center",
      lineHeight: 20,
    },
    periodRow: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 20,
    },
    periodBlock: {
      flex: 1,
      alignItems: "center",
    },
    periodBlockLabel: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.6,
    },
    periodBlockDate: {
      fontSize: 22,
      fontWeight: "900",
      color: colors.text,
      marginTop: 6,
    },
    periodBlockYear: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.textTertiary,
      marginTop: 2,
    },
    periodArrow: {
      paddingHorizontal: 16,
    },
    periodMetaRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      paddingHorizontal: 20,
      paddingBottom: 20,
    },
    periodMetaPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.cardAlt,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    periodMetaPillText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    billGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
      paddingHorizontal: 16,
      paddingVertical: 16,
      gap: 12,
    },
    billGridItem: {
      width: (SCREEN_WIDTH - 76) / 2,
      backgroundColor: colors.cardAlt,
      borderRadius: 16,
      paddingVertical: 18,
      paddingHorizontal: 12,
      alignItems: "center",
      justifyContent: "center",
    },
    billIconCircle: {
      width: 44,
      height: 44,
      borderRadius: 14,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 12,
    },
    billIconSkeleton: {
      width: 44,
      height: 44,
      borderRadius: 14,
      marginBottom: 12,
    },
    billGridLabel: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.textTertiary,
      marginBottom: 4,
    },
    billGridAmount: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.text,
    },
    billAmountSkeleton: {
      width: 88,
      height: 20,
      marginTop: 4,
    },
    grandTotalStrip: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 16,
      backgroundColor: colors.successBg,
    },
    grandTotalLabel: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.success,
    },
    grandTotalAmount: {
      fontSize: 22,
      fontWeight: "900",
      color: colors.success,
    },
    totalAmountSkeleton: {
      width: 120,
      height: 26,
      backgroundColor: colors.card,
    },
    shareList: {
      paddingHorizontal: 18,
      paddingTop: 6,
      paddingBottom: 12,
      gap: 12,
    },
    shareItem: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 14,
      paddingVertical: 14,
      borderRadius: 18,
      backgroundColor: colors.cardAlt,
    },
    shareItemLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      flex: 1,
    },
    shareItemIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 13,
      justifyContent: "center",
      alignItems: "center",
    },
    shareIconSkeleton: {
      width: 40,
      height: 40,
      borderRadius: 13,
    },
    shareItemTextWrap: {
      flex: 1,
    },
    shareItemTitleRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      flexWrap: "wrap",
    },
    shareItemLabel: {
      fontSize: 14,
      fontWeight: "700",
      color: colors.text,
    },
    shareItemSubtext: {
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 4,
      lineHeight: 17,
    },
    shareItemRight: {
      alignItems: "flex-end",
      marginLeft: 12,
    },
    shareItemValue: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
    },
    shareItemNote: {
      fontSize: 11,
      fontWeight: "600",
      color: colors.textTertiary,
      marginTop: 2,
    },
    shareNoteSkeleton: {
      width: 128,
      height: 12,
      marginTop: 8,
    },
    shareAmountSkeleton: {
      width: 92,
      height: 22,
      marginLeft: 12,
    },
    shareIntroRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 10,
      paddingHorizontal: 18,
      paddingTop: 10,
      paddingBottom: 14,
    },
    shareIntroPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.accentLight,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    shareIntroPillText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.accent,
    },
    sharePaidBadge: {
      backgroundColor: colors.success,
      borderRadius: 999,
      paddingHorizontal: 8,
      paddingVertical: 3,
    },
    sharePaidBadgeText: {
      color: colors.textOnAccent,
      fontSize: 10,
      fontWeight: "800",
      letterSpacing: 0.2,
      textTransform: "uppercase",
    },
    helperStatsRow: {
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 18,
      paddingBottom: 16,
    },
    helperStatCard: {
      flex: 1,
      backgroundColor: colors.accentLight,
      borderRadius: 16,
      paddingHorizontal: 14,
      paddingVertical: 12,
    },
    helperStatCardPressable: {
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    helperStatLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textSecondary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    helperStatValue: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.accent,
      marginTop: 8,
    },
    helperStatValueRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      gap: 4,
    },
    waterModalOverlay: {
      flex: 1,
      justifyContent: "center",
      paddingHorizontal: 20,
      backgroundColor: "rgba(0,0,0,0.45)",
    },
    waterModalCard: {
      maxHeight: "78%",
      backgroundColor: colors.card,
      borderRadius: 20,
      overflow: "hidden",
    },
    waterModalHeader: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 16,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    waterModalTitleWrap: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    waterModalIcon: {
      width: 40,
      height: 40,
      borderRadius: 12,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.infoBg,
    },
    waterModalTitle: {
      fontSize: 17,
      fontWeight: "800",
      color: colors.text,
    },
    waterModalSubtitle: {
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 2,
    },
    waterModalClose: {
      width: 34,
      height: 34,
      borderRadius: 17,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.cardAlt,
      marginLeft: 10,
    },
    waterModalTotalRow: {
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingVertical: 14,
      backgroundColor: colors.accentSurface,
    },
    waterModalTotalLabel: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.accent,
    },
    waterModalTotalAmount: {
      fontSize: 20,
      fontWeight: "900",
      color: colors.accent,
    },
    waterModalList: {
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    waterModalPersonRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: colors.borderLight,
    },
    waterModalAvatar: {
      width: 38,
      height: 38,
      borderRadius: 19,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: colors.infoBg,
    },
    waterModalAvatarText: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.waterColor,
    },
    waterModalPersonName: {
      fontSize: 14,
      fontWeight: "800",
      color: colors.text,
    },
    waterModalPersonMeta: {
      fontSize: 12,
      color: colors.textTertiary,
      lineHeight: 17,
      marginTop: 3,
    },
    waterModalPersonAmount: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.text,
      marginLeft: 8,
    },
    waterModalEmpty: {
      paddingHorizontal: 22,
      paddingVertical: 28,
      alignItems: "center",
    },
    waterModalEmptyTitle: {
      fontSize: 15,
      fontWeight: "800",
      color: colors.text,
    },
    waterModalEmptyText: {
      fontSize: 13,
      color: colors.textTertiary,
      textAlign: "center",
      lineHeight: 20,
      marginTop: 6,
    },
    totalDueStrip: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 18,
      backgroundColor: colors.accentSurface,
    },
    totalDueLabel: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.accent,
    },
    totalDueAmount: {
      fontSize: 26,
      fontWeight: "900",
      color: colors.accent,
    },
    payNowButton: {
      flexDirection: "row",
      backgroundColor: colors.accent,
      borderRadius: 16,
      marginHorizontal: 18,
      marginTop: 18,
      marginBottom: 18,
      paddingVertical: 18,
      alignItems: "center",
      justifyContent: "center",
      gap: 10,
    },
    payNowButtonDisabled: {
      backgroundColor: colors.textTertiary,
      opacity: 0.5,
    },
    payNowButtonText: {
      fontSize: 16,
      fontWeight: "800",
      color: "#fff",
      letterSpacing: 0.5,
    },
    paymentLockedBox: {
      flexDirection: "row",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingVertical: 18,
      backgroundColor: colors.accentSurface,
      gap: 14,
    },
    paymentLockedBoxWarning: {
      backgroundColor: colors.warningBg,
      borderColor: colors.warning,
      borderWidth: 1,
    },
    paymentLockedText: {
      fontSize: 14,
      fontWeight: "700",
      color: colors.accent,
    },
    paymentLockedSubtext: {
      fontSize: 12,
      fontWeight: "500",
      color: colors.textSecondary,
      marginTop: 4,
      lineHeight: 18,
    },
    paymentLockedTextWarning: {
      fontSize: 14,
      fontWeight: "700",
      color: colors.warning,
    },
    paymentLockedSubtextWarning: {
      fontSize: 12,
      fontWeight: "500",
      color: colors.textSecondary,
      marginTop: 4,
      lineHeight: 18,
    },
    actionsSection: {
      paddingHorizontal: 16,
      marginTop: 24,
      gap: 12,
    },
    sectionLabel: {
      fontSize: 18,
      fontWeight: "800",
      color: colors.text,
      letterSpacing: -0.3,
    },
    sectionSubtext: {
      fontSize: 13,
      color: colors.textTertiary,
      lineHeight: 18,
      marginTop: -4,
      marginBottom: 2,
    },
    actionCard: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      borderRadius: 16,
      paddingHorizontal: 16,
      paddingVertical: 16,
      shadowColor: "#555",
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    actionIconBg: {
      width: 44,
      height: 44,
      borderRadius: 14,
      justifyContent: "center",
      alignItems: "center",
      marginRight: 14,
    },
    actionCardBody: {
      flex: 1,
      paddingRight: 10,
    },
    actionCardText: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.text,
    },
    actionCardSubtext: {
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 3,
      lineHeight: 17,
    },
    emptyStateContainer: {
      flex: 1,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 36,
      paddingTop: 60,
      paddingBottom: 40,
    },
    emptyStateIconBg: {
      width: 88,
      height: 88,
      borderRadius: 28,
      backgroundColor: colors.accentLight,
      alignItems: "center",
      justifyContent: "center",
      marginBottom: 24,
    },
    emptyStateTitle: {
      fontSize: 22,
      fontWeight: "800",
      color: colors.text,
      textAlign: "center",
      marginBottom: 10,
    },
    emptyStateSubtext: {
      fontSize: 14,
      color: colors.textSecondary,
      textAlign: "center",
      lineHeight: 22,
      marginBottom: 32,
    },
    emptyStateCta: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.accent,
      borderRadius: 14,
      paddingHorizontal: 24,
      paddingVertical: 14,
    },
    emptyStateCtaText: {
      fontSize: 15,
      fontWeight: "700",
      color: "#fff",
    },
  });

export default BillsScreen;
