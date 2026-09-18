import React, { useState, useEffect, useContext, useRef, useMemo } from "react";
import { useFocusEffect } from "@react-navigation/native";
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  RefreshControl,
  Animated,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  presenceService,
  roomService,
  paymentService,
} from "../../services/apiService";
import { AuthContext } from "../../context/AuthContext";
import { useTheme } from "../../theme/ThemeContext";
import { ScrollViewWithDetection } from "../../components/ScrollDetectionWrappers";
import { Toast, ConfirmModal } from "../../components/CustomAlert";

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

const PresenceLoadingSkeleton = ({ colors, styles }) => (
  <ScrollViewWithDetection
    style={styles.container}
    contentContainerStyle={styles.loadingScrollContent}
    showsVerticalScrollIndicator={false}
  >
    <View style={styles.header}>
      <View style={styles.headerContent}>
        <View style={styles.headerTitleRow}>
          <AmountSkeleton
            colors={colors}
            style={[styles.loadingHeaderIcon, styles.loadingOnHeader]}
          />
          <View style={{ flex: 1 }}>
            <AmountSkeleton
              colors={colors}
              style={[styles.loadingHeaderTitle, styles.loadingOnHeader]}
            />
            <AmountSkeleton
              colors={colors}
              style={[styles.loadingHeaderSubtitle, styles.loadingOnHeader]}
            />
          </View>
        </View>
        <AmountSkeleton
          colors={colors}
          style={[styles.loadingHeaderFootnote, styles.loadingOnHeader]}
        />
        <AmountSkeleton
          colors={colors}
          style={[styles.loadingHeaderFootnoteShort, styles.loadingOnHeader]}
        />
        <View style={styles.headerStatusRow}>
          <AmountSkeleton
            colors={colors}
            style={[styles.loadingStatusChip, styles.loadingOnHeader]}
          />
          <AmountSkeleton
            colors={colors}
            style={[styles.loadingStatusChipWide, styles.loadingOnHeader]}
          />
        </View>
      </View>
    </View>

    <View style={styles.roomSelectorContainer}>
      <ScrollViewWithDetection
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={styles.roomPillsRow}
      >
        {[0, 1, 2].map((item) => (
          <AmountSkeleton
            key={item}
            colors={colors}
            style={styles.loadingRoomPill}
          />
        ))}
      </ScrollViewWithDetection>
    </View>

    <View style={styles.contentPadding}>
      <View style={styles.summaryCard}>
        <View style={styles.summaryTopRow}>
          <View style={styles.summaryCopy}>
            <AmountSkeleton
              colors={colors}
              style={styles.loadingSummaryEyebrow}
            />
            <AmountSkeleton
              colors={colors}
              style={styles.loadingSummaryTitle}
            />
            <AmountSkeleton
              colors={colors}
              style={styles.loadingSummaryValue}
            />
            <AmountSkeleton
              colors={colors}
              style={styles.loadingSummaryText}
            />
          </View>
          <View style={styles.summaryBadgeStack}>
            <AmountSkeleton colors={colors} style={styles.loadingBadge} />
            <AmountSkeleton colors={colors} style={styles.loadingBadgeWide} />
          </View>
        </View>

        <View style={styles.summaryStatsRow}>
          {[0, 1, 2, 3].map((item) => (
            <View key={item} style={styles.summaryStatCard}>
              <AmountSkeleton
                colors={colors}
                style={styles.loadingStatValue}
              />
              <AmountSkeleton
                colors={colors}
                style={styles.loadingStatLabel}
              />
            </View>
          ))}
        </View>
      </View>
    </View>

    <View style={styles.card}>
      <View style={styles.cardHeader}>
        <AmountSkeleton colors={colors} style={styles.loadingCardIcon} />
        <AmountSkeleton colors={colors} style={styles.loadingCardTitle} />
      </View>
      <AmountSkeleton colors={colors} style={styles.loadingPrimaryButton} />
      <View style={styles.bulkRow}>
        <AmountSkeleton colors={colors} style={styles.loadingBulkButton} />
        <AmountSkeleton colors={colors} style={styles.loadingBulkButton} />
      </View>
      <AmountSkeleton colors={colors} style={styles.loadingTipLine} />
    </View>

    <View style={styles.card}>
      <View style={styles.calendarNav}>
        <AmountSkeleton colors={colors} style={styles.loadingNavButton} />
        <AmountSkeleton colors={colors} style={styles.loadingMonthLabel} />
        <AmountSkeleton colors={colors} style={styles.loadingNavButton} />
      </View>
      <View style={styles.weekRow}>
        {[0, 1, 2, 3, 4, 5, 6].map((item) => (
          <View key={item} style={styles.weekCell}>
            <AmountSkeleton colors={colors} style={styles.loadingWeekLabel} />
          </View>
        ))}
      </View>
      <View style={styles.dayGrid}>
        {Array.from({ length: 42 }).map((_, index) => (
          <View key={index} style={styles.dayCell}>
            <AmountSkeleton colors={colors} style={styles.loadingDayCell} />
          </View>
        ))}
      </View>
    </View>

    <View style={{ height: 36 }} />
  </ScrollViewWithDetection>
);

const PresenceScreen = () => {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const styles = createStyles(colors, insets);

  const { state } = useContext(AuthContext);
  const userId = state?.user?.id || state?.user?._id;
  const [rooms, setRooms] = useState([]);
  const [selectedRoom, setSelectedRoom] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [hasPendingPayment, setHasPendingPayment] = useState(false);
  const pendingUpdatesRef = useRef(new Set());
  const memberRecordIdRef = useRef(null);
  const outOfCycleDatesRef = useRef([]);
  const inFlightRef = useRef(false);
  const pendingDatesRef = useRef(null);
  const detailsLoadingRoomIdRef = useRef(null);
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [waterSplitMode, setWaterSplitMode] = useState("all_payors");
  const [selectedWaterPayorIds, setSelectedWaterPayorIds] = useState([]);
  const [savingWaterPreference, setSavingWaterPreference] = useState(false);

  // Custom alerts
  const [toast, setToast] = useState({
    visible: false,
    type: "success",
    message: "",
  });
  const [confirmModal, setConfirmModal] = useState({
    visible: false,
    config: {},
  });

  const showToast = (message, type = "success") =>
    setToast({ visible: true, type, message });

  const showConfirm = (config) => setConfirmModal({ visible: true, config });

  const getRoomId = (room) => room?.id || room?._id;

  const hasActiveCycle = Boolean(
    selectedRoom?.currentCycleId ||
    (selectedRoom?.billing?.start && selectedRoom?.billing?.end),
  );

  const userPaidStatus = useMemo(() => {
    if (!selectedRoom || !userId) return false;
    const userPayment = selectedRoom.memberPayments?.find(
      (mp) => String(mp.member) === String(userId),
    );
    if (!userPayment) return false;
    return (
      userPayment.rentStatus === "paid" &&
      userPayment.electricityStatus === "paid" &&
      userPayment.waterStatus === "paid"
    );
  }, [selectedRoom, userId, selectedRoom?.memberPayments?.length]);

  const isFixedMonthlyWater =
    selectedRoom?.waterBillingMode === "fixed_monthly" ||
    selectedRoom?.water_billing_mode === "fixed_monthly";
  const waterFixedType =
    selectedRoom?.waterFixedType || selectedRoom?.water_fixed_type || "by_room";
  const canMarkPresence =
    hasActiveCycle &&
    !userPaidStatus &&
    !hasPendingPayment &&
    !isFixedMonthlyWater &&
    selectedRoom?.cycleStatus !== "cycle_closed";

  const [markedDates, setMarkedDates] = useState([]);
  const markedDatesSet = useMemo(() => new Set(markedDates), [markedDates]);
  const [rangeStartDate, setRangeStartDate] = useState(null);
  const [markingMultiple, setMarkingMultiple] = useState(false);

  const getMemberUserId = (member) =>
    String(
      member?.user?.id ||
        member?.user?._id ||
        member?.user ||
        member?.userId ||
        member?.user_id ||
        "",
    );

  const currentUserMember = useMemo(() => {
    if (!selectedRoom?.members || !userId) return null;
    return selectedRoom.members.find(
      (member) => getMemberUserId(member) === String(userId),
    );
  }, [selectedRoom?.members, userId]);

  const isCurrentUserPayor =
    currentUserMember?.isPayer !== undefined
      ? currentUserMember.isPayer
      : currentUserMember?.is_payer !== false;

  const waterPayorMembers = useMemo(
    () =>
      (selectedRoom?.members || []).filter((member) =>
        member?.isPayer !== undefined
          ? member.isPayer
          : member.is_payer !== false,
      ),
    [selectedRoom?.members],
  );

  const canChooseWaterPayors =
    !!selectedRoom &&
    currentUserMember &&
    !isCurrentUserPayor &&
    (!isFixedMonthlyWater || waterFixedType === "per_person") &&
    waterPayorMembers.length > 0;

  useFocusEffect(
    React.useCallback(() => {
      const refresh = async () => {
        try {
          setLoading(true);
          const response = await roomService.getClientRooms();
          const data = response.data || response;
          const fetchedRooms = data.rooms || data || [];
          setRooms(fetchedRooms);
          if (fetchedRooms.length > 0) {
            const nextRoom = fetchedRooms[0];
            const nextRoomId = getRoomId(nextRoom);
            detailsLoadingRoomIdRef.current = nextRoomId;
            setSelectedRoom(nextRoom);
            await loadMarkedDates(nextRoom);
            detailsLoadingRoomIdRef.current = null;
            if (nextRoom?.billing?.start) {
              const billingStart = new Date(nextRoom.billing.start);
              setCurrentMonth(
                new Date(
                  billingStart.getFullYear(),
                  billingStart.getMonth(),
                  1,
                ),
              );
            }
          } else {
            setSelectedRoom(null);
            setMarkedDates([]);
            setHasPendingPayment(false);
            memberRecordIdRef.current = null;
            outOfCycleDatesRef.current = [];
          }
        } catch (error) {
          console.error("Error refreshing rooms:", error);
          detailsLoadingRoomIdRef.current = null;
        } finally {
          setLoading(false);
        }
      };
      refresh();
    }, []),
  );

  useEffect(() => {
    const roomId = getRoomId(selectedRoom);
    if (selectedRoom && roomId) {
      if (detailsLoadingRoomIdRef.current === roomId) {
        return;
      }

      let cancelled = false;
      const syncSelectedRoomDetails = async () => {
        try {
          setLoading(true);
          detailsLoadingRoomIdRef.current = roomId;
          await loadMarkedDates(selectedRoom);
        } finally {
          if (detailsLoadingRoomIdRef.current === roomId) {
            detailsLoadingRoomIdRef.current = null;
          }
          if (!cancelled) setLoading(false);
        }
      };

      syncSelectedRoomDetails();

      if (selectedRoom?.billing?.start) {
        const billingStart = new Date(selectedRoom.billing.start);
        setCurrentMonth(
          new Date(billingStart.getFullYear(), billingStart.getMonth(), 1),
        );
      }

      return () => {
        cancelled = true;
      };
    }
  }, [selectedRoom?.id || selectedRoom?._id]);

  useEffect(() => {
    if (!currentUserMember) {
      setWaterSplitMode("all_payors");
      setSelectedWaterPayorIds([]);
      return;
    }

    const mode =
      currentUserMember.waterSplitMode ||
      currentUserMember.water_split_mode ||
      "all_payors";
    const payorIds =
      currentUserMember.waterSplitPayorIds ||
      currentUserMember.water_split_payor_ids ||
      [];

    setWaterSplitMode(mode === "specific_payors" ? mode : "all_payors");
    setSelectedWaterPayorIds(
      Array.isArray(payorIds) ? payorIds.map(String) : [],
    );
  }, [
    currentUserMember?.id,
    currentUserMember?.waterSplitMode,
    currentUserMember?.water_split_mode,
    currentUserMember?.waterSplitPayorIds?.length,
    currentUserMember?.water_split_payor_ids?.length,
  ]);

  const fetchRooms = async (skipAutoSelect = false) => {
    try {
      setLoading(true);
      const response = await roomService.getClientRooms();
      const data = response.data || response;
      const fetchedRooms = data.rooms || data || [];
      setRooms(fetchedRooms);

      if (fetchedRooms.length === 0) {
        setSelectedRoom(null);
        setMarkedDates([]);
        setHasPendingPayment(false);
        memberRecordIdRef.current = null;
        outOfCycleDatesRef.current = [];
        return;
      }

      if (!skipAutoSelect) {
        const selectedRoomId = getRoomId(selectedRoom);
        const nextRoom =
          fetchedRooms.find(
            (room) => String(getRoomId(room)) === String(selectedRoomId),
          ) || fetchedRooms[0];
        const nextRoomId = getRoomId(nextRoom);
        detailsLoadingRoomIdRef.current = nextRoomId;
        setSelectedRoom(nextRoom);
        await loadMarkedDates(nextRoom);
        detailsLoadingRoomIdRef.current = null;
      }
    } catch (error) {
      console.error("Error fetching rooms:", error);
      showToast("Failed to load rooms", "error");
    } finally {
      detailsLoadingRoomIdRef.current = null;
      setLoading(false);
    }
  };

  const onRefresh = async () => {
    setRefreshing(true);
    await fetchRooms();
    setRefreshing(false);
  };

  const updateCurrentMemberInRoom = (updatedMember) => {
    if (!updatedMember) return;
    setSelectedRoom((prev) => {
      if (!prev?.members) return prev;
      return {
        ...prev,
        members: prev.members.map((member) =>
          String(member.id) === String(updatedMember.id) ||
          getMemberUserId(member) ===
            String(updatedMember.userId || updatedMember.user_id)
            ? { ...member, ...updatedMember }
            : member,
        ),
      };
    });
  };

  const toggleWaterPayor = (payorId) => {
    setWaterSplitMode("specific_payors");
    setSelectedWaterPayorIds((current) => {
      const id = String(payorId);
      if (current.includes(id)) return current.filter((item) => item !== id);
      if (current.length >= 3) {
        showToast("You can select up to 3 payors only.", "warning");
        return current;
      }
      return [...current, id];
    });
  };

  const saveWaterPayorPreference = async () => {
    if (!selectedRoom) return;
    if (
      waterSplitMode === "specific_payors" &&
      selectedWaterPayorIds.length === 0
    ) {
      showToast("Choose at least one payor for your water bill.", "warning");
      return;
    }

    try {
      setSavingWaterPreference(true);
      const roomId = selectedRoom.id || selectedRoom._id;
      const response = await roomService.updateWaterPayorPreference(roomId, {
        mode: waterSplitMode,
        payorIds:
          waterSplitMode === "specific_payors" ? selectedWaterPayorIds : [],
      });
      updateCurrentMemberInRoom(response.member);
      showToast("Water payor preference updated.", "success");
      await loadMarkedDates();
    } catch (error) {
      console.error("Error saving water payor preference:", error);
      showToast(
        error?.response?.data?.message ||
          error?.message ||
          "Failed to update water payor preference.",
        "error",
      );
    } finally {
      setSavingWaterPreference(false);
    }
  };

  const loadMarkedDates = async (roomToLoad = selectedRoom) => {
    if (!roomToLoad || !userId) return;
    try {
      const roomId = getRoomId(roomToLoad);
      const roomResponse = await roomService.getRoomById(roomId);
      const roomData = roomResponse.data || roomResponse;
      const room = roomData.room || roomData;

      if (room.memberPayments) {
        setSelectedRoom((prev) =>
          prev
            ? {
                ...prev,
                members: room.members ?? prev.members,
                memberPayments: room.memberPayments,
                billing: room.billing ?? prev.billing,
                cycleStatus: room.cycleStatus ?? prev.cycleStatus,
                waterBillingMode:
                  room.waterBillingMode ??
                  room.water_billing_mode ??
                  prev.waterBillingMode,
                water_billing_mode:
                  room.water_billing_mode ??
                  room.waterBillingMode ??
                  prev.water_billing_mode,
                waterFixedType:
                  room.waterFixedType ??
                  room.water_fixed_type ??
                  prev.waterFixedType,
                water_fixed_type:
                  room.water_fixed_type ??
                  room.waterFixedType ??
                  prev.water_fixed_type,
              }
            : prev,
        );
      }

      try {
        const payRes = await paymentService.getPaymentHistory(roomId, {
          status: "pending",
          limit: 1,
          includeUser: false,
        });
        const payments = payRes?.payments || [];
        const pending = payments.some(
          (p) => p.status === "submitted" || p.status === "pending",
        );
        setHasPendingPayment(pending);
      } catch (_) {
        setHasPendingPayment(false);
      }

      const currentUserMember = room.members?.find(
        (m) => String(m.user?.id || m.user?._id || m.user) === String(userId),
      );

      if (currentUserMember && Array.isArray(currentUserMember.presence)) {
        const allNormalized = currentUserMember.presence
          .map((d) => formatToYMD(d))
          .filter(Boolean);

        const cycleStart = room.billing?.start
          ? formatToYMD(new Date(room.billing.start))
          : null;
        const cycleEnd = room.billing?.end
          ? formatToYMD(new Date(room.billing.end))
          : null;

        let cycleDates;
        if (cycleStart && cycleEnd) {
          cycleDates = allNormalized.filter(
            (d) => d >= cycleStart && d <= cycleEnd,
          );
          outOfCycleDatesRef.current = allNormalized.filter(
            (d) => d < cycleStart || d > cycleEnd,
          );
        } else {
          cycleDates = allNormalized;
          outOfCycleDatesRef.current = [];
        }

        setMarkedDates(cycleDates);
        memberRecordIdRef.current = currentUserMember.id || null;
      } else {
        setMarkedDates([]);
        outOfCycleDatesRef.current = [];
        memberRecordIdRef.current = null;
      }
    } catch (error) {
      console.error("Error loading marked dates:", error);
    }
  };

  const markPresence = async (date) => {
    if (!selectedRoom || !userId) return;

    if (!canMarkPresence) {
      if (isFixedMonthlyWater) {
        showToast(
          "Fixed water billing is set. Presence tracking is not required.",
          "info",
        );
      } else if (hasPendingPayment) {
        showToast(
          "A payment is awaiting host verification. Presence is locked until it's approved.",
          "warning",
        );
      } else {
        showToast(
          "No active billing cycle. Please contact your admin.",
          "info",
        );
      }
      return;
    }

    const dateStr = formatToYMD(date);

    if (pendingUpdatesRef.current.has(dateStr) && inFlightRef.current) {
      return;
    }

    pendingUpdatesRef.current.add(dateStr);
    const prevMarked = [...markedDates];
    const isCurrentlyMarked = prevMarked.includes(dateStr);
    const optimisticallyMarked = isCurrentlyMarked
      ? prevMarked.filter((d) => d !== dateStr)
      : [...prevMarked, dateStr];
    const updatedDates = Array.from(new Set(optimisticallyMarked)).sort();

    setMarkedDates(updatedDates);
    if (selectedRoom && selectedRoom.members) {
      const updatedMembers = selectedRoom.members.map((m) => {
        if (String(m.user?.id || m.user?._id || m.user) === String(userId)) {
          return { ...m, presence: updatedDates };
        }
        return m;
      });
      setSelectedRoom({ ...selectedRoom, members: updatedMembers });
    }

    if (inFlightRef.current) {
      pendingDatesRef.current = updatedDates;
      pendingUpdatesRef.current.clear();
      return;
    }

    const sendPresence = async (dates) => {
      inFlightRef.current = true;
      const roomId = selectedRoom.id || selectedRoom._id;
      try {
        const allDatesToSave = Array.from(
          new Set([...dates, ...outOfCycleDatesRef.current]),
        ).sort();
        await presenceService.markPresence(roomId, {
          presenceDates: allDatesToSave,
          memberRecordId: memberRecordIdRef.current ?? undefined,
        });
      } catch (error) {
        console.error("❌ Error marking presence:", error);
        setMarkedDates(prevMarked);
        if (selectedRoom && selectedRoom.members) {
          const revertedMembers = selectedRoom.members.map((m) => {
            if (
              String(m.user?.id || m.user?._id || m.user) === String(userId)
            ) {
              return { ...m, presence: prevMarked };
            }
            return m;
          });
          setSelectedRoom((prev) => ({ ...prev, members: revertedMembers }));
        }
        showToast(error.message || "Failed to update presence", "error");
      } finally {
        inFlightRef.current = false;
        pendingUpdatesRef.current.clear();
        if (pendingDatesRef.current !== null) {
          const next = pendingDatesRef.current;
          pendingDatesRef.current = null;
          await sendPresence(next);
        }
      }
    };

    pendingUpdatesRef.current.clear();
    sendPresence(updatedDates);
  };

  const markAllCurrentMonth = async () => {
    if (!selectedRoom || !userId) return;
    if (!hasActiveCycle) {
      showToast("No active billing cycle. Contact your admin.", "info");
      return;
    }
    try {
      setMarkingMultiple(true);
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const daysInMonth = getDaysInMonth(currentMonth);
      let datesToAdd = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        if (isDateMarkable(date)) datesToAdd.push(formatToYMD(date));
      }
      let updatedDates = [...new Set([...markedDates, ...datesToAdd])];
      updatedDates.sort();
      const allDatesToSave = Array.from(
        new Set([...updatedDates, ...outOfCycleDatesRef.current]),
      ).sort();
      await presenceService.markPresence(selectedRoom.id || selectedRoom._id, {
        presenceDates: allDatesToSave,
      });
      setMarkedDates(updatedDates);
      if (selectedRoom && selectedRoom.members) {
        const updatedMembers = selectedRoom.members.map((m) => {
          if (String(m.user?.id || m.user?._id || m.user) === String(userId))
            return { ...m, presence: updatedDates };
          return m;
        });
        setSelectedRoom({ ...selectedRoom, members: updatedMembers });
      }
      showToast(
        `Marked ${datesToAdd.length} dates in ${currentMonth.toLocaleDateString("en-US", { month: "long" })}`,
        "success",
      );
    } catch (error) {
      showToast(error.message || "Failed to mark all dates", "error");
    } finally {
      setMarkingMultiple(false);
    }
  };

  const markWorkdaysCurrentMonth = async () => {
    if (!selectedRoom || !userId) return;
    if (!hasActiveCycle) {
      showToast("No active billing cycle. Contact your admin.", "info");
      return;
    }
    try {
      setMarkingMultiple(true);
      const year = currentMonth.getFullYear();
      const month = currentMonth.getMonth();
      const daysInMonth = getDaysInMonth(currentMonth);
      let datesToAdd = [];
      for (let day = 1; day <= daysInMonth; day++) {
        const date = new Date(year, month, day);
        const dayOfWeek = date.getDay();
        const isWorkday = dayOfWeek > 0 && dayOfWeek < 6;
        if (isDateMarkable(date) && isWorkday)
          datesToAdd.push(formatToYMD(date));
      }
      let updatedDates = [...new Set([...markedDates, ...datesToAdd])];
      updatedDates.sort();
      const allDatesToSave = Array.from(
        new Set([...updatedDates, ...outOfCycleDatesRef.current]),
      ).sort();
      await presenceService.markPresence(selectedRoom.id || selectedRoom._id, {
        presenceDates: allDatesToSave,
      });
      setMarkedDates(updatedDates);
      if (selectedRoom && selectedRoom.members) {
        const updatedMembers = selectedRoom.members.map((m) => {
          if (String(m.user?.id || m.user?._id || m.user) === String(userId))
            return { ...m, presence: updatedDates };
          return m;
        });
        setSelectedRoom({ ...selectedRoom, members: updatedMembers });
      }
      showToast(
        `Marked ${datesToAdd.length} workdays in ${currentMonth.toLocaleDateString("en-US", { month: "long" })}`,
        "success",
      );
    } catch (error) {
      showToast(error.message || "Failed to mark workdays", "error");
    } finally {
      setMarkingMultiple(false);
    }
  };

  const markDateRange = async (startDate, endDate) => {
    if (!selectedRoom || !userId) return;
    if (!hasActiveCycle) {
      showToast("No active billing cycle. Contact your admin.", "info");
      return;
    }
    try {
      setMarkingMultiple(true);
      const start = new Date(startDate);
      const end = new Date(endDate);
      if (start > end) {
        showToast("Start date must be before end date", "error");
        setMarkingMultiple(false);
        return;
      }
      let datesToAdd = [];
      const currentDate = new Date(start);
      while (currentDate <= end) {
        if (isDateMarkable(currentDate))
          datesToAdd.push(formatToYMD(currentDate));
        currentDate.setDate(currentDate.getDate() + 1);
      }
      let updatedDates = [...new Set([...markedDates, ...datesToAdd])];
      updatedDates.sort();
      const allDatesToSave = Array.from(
        new Set([...updatedDates, ...outOfCycleDatesRef.current]),
      ).sort();
      await presenceService.markPresence(selectedRoom.id || selectedRoom._id, {
        presenceDates: allDatesToSave,
      });
      setMarkedDates(updatedDates);
      if (selectedRoom && selectedRoom.members) {
        const updatedMembers = selectedRoom.members.map((m) => {
          if (String(m.user?.id || m.user?._id || m.user) === String(userId))
            return { ...m, presence: updatedDates };
          return m;
        });
        setSelectedRoom({ ...selectedRoom, members: updatedMembers });
      }
      showToast(
        `Marked ${datesToAdd.length} dates from ${start.toLocaleDateString()} to ${end.toLocaleDateString()}`,
        "success",
      );
      setRangeStartDate(null);
    } catch (error) {
      showToast(error.message || "Failed to mark date range", "error");
    } finally {
      setMarkingMultiple(false);
    }
  };

  const getDaysInMonth = (date) =>
    new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();

  const getFirstDayOfMonth = (date) =>
    new Date(date.getFullYear(), date.getMonth(), 1).getDay();

  const formatToYMD = (date) => {
    if (!date) return null;
    const d = new Date(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  };

  const generateCalendarDays = () => {
    const year = currentMonth.getFullYear();
    const month = currentMonth.getMonth();
    const daysInMonth = getDaysInMonth(currentMonth);
    const firstDay = getFirstDayOfMonth(currentMonth);
    const days = [];
    for (let i = 0; i < firstDay; i++) days.push(null);
    for (let day = 1; day <= daysInMonth; day++)
      days.push(new Date(year, month, day));
    return days;
  };

  const isDateMarked = (date) => {
    if (!date) return false;
    return markedDatesSet.has(formatToYMD(date));
  };

  const isToday = (date) => {
    if (!date) return false;
    const today = new Date();
    return (
      date.getDate() === today.getDate() &&
      date.getMonth() === today.getMonth() &&
      date.getFullYear() === today.getFullYear()
    );
  };

  const isFutureDate = (date) => {
    if (!date) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return date > today;
  };

  const isDateInBillingRange = (date) => {
    if (!date || !selectedRoom?.billing) return false;
    const dateStr = formatToYMD(date);
    const billingStartStr = formatToYMD(new Date(selectedRoom.billing.start));
    const billingEndStr = formatToYMD(new Date(selectedRoom.billing.end));
    if (!billingStartStr || !billingEndStr) return false;
    return dateStr >= billingStartStr && dateStr <= billingEndStr;
  };

  const isDateMarkable = (date) =>
    hasActiveCycle && isDateInBillingRange(date) && !isFutureDate(date);

  const calendarDays = useMemo(() => generateCalendarDays(), [currentMonth]);
  const monthName = currentMonth.toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });

  const canGoPrevMonth = useMemo(() => {
    if (!selectedRoom?.billing?.start) return true;
    const billingStart = new Date(selectedRoom.billing.start);
    return (
      currentMonth.getFullYear() > billingStart.getFullYear() ||
      (currentMonth.getFullYear() === billingStart.getFullYear() &&
        currentMonth.getMonth() > billingStart.getMonth())
    );
  }, [currentMonth, selectedRoom?.billing?.start]);

  const canGoNextMonth = useMemo(() => {
    if (!selectedRoom?.billing?.end) return true;
    const billingEnd = new Date(selectedRoom.billing.end);
    return (
      currentMonth.getFullYear() < billingEnd.getFullYear() ||
      (currentMonth.getFullYear() === billingEnd.getFullYear() &&
        currentMonth.getMonth() < billingEnd.getMonth())
    );
  }, [currentMonth, selectedRoom?.billing?.end]);

  // ── Derived stats ──────────────────────────────────────────────
  const totalBillingDays = useMemo(() => {
    if (!selectedRoom?.billing?.start || !selectedRoom?.billing?.end) return 0;
    const start = new Date(selectedRoom.billing.start);
    const end = new Date(selectedRoom.billing.end);
    return Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
  }, [selectedRoom?.billing]);

  const attendanceRate =
    totalBillingDays > 0
      ? Math.round((markedDates.length / totalBillingDays) * 100)
      : 0;
  const estimatedWaterBill = markedDates.length * 5;
  const remainingBillingDays = Math.max(
    totalBillingDays - markedDates.length,
    0,
  );
  const billingPeriodLabel =
    selectedRoom?.billing?.start && selectedRoom?.billing?.end
      ? `${new Date(selectedRoom.billing.start).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })} - ${new Date(selectedRoom.billing.end).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
        })}`
      : "No active billing period";
  const presenceStatusMeta = canMarkPresence
    ? {
        label: "Open",
        backgroundColor: colors.successBg,
        color: colors.success,
        icon: "checkmark-circle",
      }
    : selectedRoom?.cycleStatus === "cycle_closed" && !userPaidStatus
      ? {
          label: "Closed",
          backgroundColor: colors.errorBg,
          color: colors.error,
          icon: "lock-closed",
        }
      : userPaidStatus
        ? {
            label: "Paid",
            backgroundColor: colors.successBg,
            color: colors.success,
            icon: "shield-checkmark",
          }
        : isFixedMonthlyWater
          ? {
              label: "Fixed",
              backgroundColor: colors.infoBg,
              color: colors.info,
              icon: "water",
            }
          : hasPendingPayment
            ? {
                label: "Pending",
                backgroundColor: colors.warningBg,
                color: colors.warning,
                icon: "hourglass-outline",
              }
            : {
                label: "No cycle",
                backgroundColor: colors.cardAlt,
                color: colors.textSecondary,
                icon: "time-outline",
              };
  const summaryStats = [
    { label: "Marked", value: `${markedDates.length}` },
    { label: "Water est.", value: `\u20B1${estimatedWaterBill.toFixed(0)}` },
    { label: "Progress", value: `${attendanceRate}%` },
    {
      label: "Cycle days",
      value: totalBillingDays ? `${totalBillingDays}` : "--",
    },
  ];

  if (loading) {
    return <PresenceLoadingSkeleton colors={colors} styles={styles} />;
  }

  return (
    <>
      <Toast
        visible={toast.visible}
        type={toast.type}
        message={toast.message}
        onHide={() => setToast((t) => ({ ...t, visible: false }))}
      />
      <ScrollViewWithDetection
        style={styles.container}
        contentContainerStyle={styles.scrollContent}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        {/* ─── HERO HEADER ─── */}
        <View style={styles.header}>
          <View style={styles.headerContent}>
            <View style={styles.headerTitleRow}>
              <View style={styles.headerIconBg}>
                <Ionicons name="calendar" size={22} color="#fff" />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.headerTitle}>Presence</Text>
                <Text style={styles.headerSubtitle}>
                  {selectedRoom ? selectedRoom.name : "Select a room to begin"}
                </Text>
              </View>
            </View>
            <Text style={styles.headerFootnote}>
              Mark the days you stayed in the room and keep your water billing
              history accurate for the active cycle.
            </Text>
            <View style={styles.headerStatusRow}>
              <View style={styles.headerStatusChip}>
                <Ionicons
                  name={presenceStatusMeta.icon}
                  size={13}
                  color="#d8efe8"
                />
                <Text style={styles.headerStatusChipText}>
                  {selectedRoom ? presenceStatusMeta.label : "Waiting"}
                </Text>
              </View>
              <View style={styles.headerStatusChip}>
                <Ionicons name="water-outline" size={13} color="#d8efe8" />
                <Text style={styles.headerStatusChipText}>
                  {selectedRoom
                    ? `\u20B1${estimatedWaterBill.toFixed(0)} water est.`
                    : "Water estimate"}
                </Text>
              </View>
            </View>
          </View>
        </View>

        {/* ─── ROOM PILLS ─── */}
        {rooms.length > 0 && (
          <View style={styles.roomSelectorContainer}>
            <ScrollViewWithDetection
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.roomPillsRow}
            >
              {rooms.map((room) => {
                const active =
                  (selectedRoom?.id || selectedRoom?._id) ===
                  (room.id || room._id);
                return (
                  <TouchableOpacity
                    key={room.id || room._id}
                    style={[styles.roomPill, active && styles.roomPillActive]}
                    onPress={() => setSelectedRoom(room)}
                    activeOpacity={0.75}
                  >
                    <View
                      style={[
                        styles.roomPillDot,
                        active && styles.roomPillDotActive,
                      ]}
                    />
                    <Text
                      style={[
                        styles.roomPillText,
                        active && styles.roomPillTextActive,
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

        {selectedRoom && (
          <View style={styles.contentPadding}>
            <View style={styles.summaryCard}>
              <View style={styles.summaryTopRow}>
                <View style={styles.summaryCopy}>
                  <Text style={styles.summaryEyebrow}>Current snapshot</Text>
                  <Text style={styles.summaryTitle}>Presence this cycle</Text>
                  <Text style={styles.summaryPrimaryValue}>
                    {markedDates.length} days
                  </Text>
                  <Text style={styles.summarySubtext}>
                    {canMarkPresence
                      ? `${remainingBillingDays} cycle day(s) still unmarked.`
                      : "Presence marking is locked for this room right now."}
                  </Text>
                </View>
                <View style={styles.summaryBadgeStack}>
                  <View
                    style={[
                      styles.summaryBadge,
                      { backgroundColor: presenceStatusMeta.backgroundColor },
                    ]}
                  >
                    <Text
                      style={[
                        styles.summaryBadgeText,
                        { color: presenceStatusMeta.color },
                      ]}
                    >
                      {presenceStatusMeta.label}
                    </Text>
                  </View>
                  <View style={styles.summaryBadge}>
                    <Text style={styles.summaryBadgeText}>
                      {billingPeriodLabel}
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

        {canChooseWaterPayors && (
          <View style={styles.waterSplitCard}>
            <View style={styles.waterSplitHeader}>
              <View style={styles.waterSplitIcon}>
                <Ionicons
                  name="water-outline"
                  size={18}
                  color={colors.accent}
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.waterSplitTitle}>Water Payor Split</Text>
                <Text style={styles.waterSplitSub}>
                  Choose who will absorb your water bill for this cycle.
                </Text>
              </View>
            </View>

            <View style={styles.waterModeRow}>
              <TouchableOpacity
                style={[
                  styles.waterModeChip,
                  waterSplitMode === "all_payors" && styles.waterModeChipActive,
                ]}
                onPress={() => {
                  setWaterSplitMode("all_payors");
                  setSelectedWaterPayorIds([]);
                }}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={
                    waterSplitMode === "all_payors"
                      ? "checkmark-circle"
                      : "ellipse-outline"
                  }
                  size={16}
                  color={
                    waterSplitMode === "all_payors"
                      ? colors.textOnAccent
                      : colors.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.waterModeText,
                    waterSplitMode === "all_payors" &&
                      styles.waterModeTextActive,
                  ]}
                >
                  Split all payors
                </Text>
              </TouchableOpacity>

              <TouchableOpacity
                style={[
                  styles.waterModeChip,
                  waterSplitMode === "specific_payors" &&
                    styles.waterModeChipActive,
                ]}
                onPress={() => setWaterSplitMode("specific_payors")}
                activeOpacity={0.75}
              >
                <Ionicons
                  name={
                    waterSplitMode === "specific_payors"
                      ? "checkmark-circle"
                      : "ellipse-outline"
                  }
                  size={16}
                  color={
                    waterSplitMode === "specific_payors"
                      ? colors.textOnAccent
                      : colors.textSecondary
                  }
                />
                <Text
                  style={[
                    styles.waterModeText,
                    waterSplitMode === "specific_payors" &&
                      styles.waterModeTextActive,
                  ]}
                >
                  Specific payors
                </Text>
              </TouchableOpacity>
            </View>

            {waterSplitMode === "specific_payors" && (
              <View style={styles.payorChoiceWrap}>
                {waterPayorMembers.map((member) => {
                  const payorId = getMemberUserId(member);
                  const selected = selectedWaterPayorIds.includes(payorId);
                  return (
                    <TouchableOpacity
                      key={payorId || member.id}
                      style={[
                        styles.payorChoiceChip,
                        selected && styles.payorChoiceChipActive,
                      ]}
                      onPress={() => toggleWaterPayor(payorId)}
                      activeOpacity={0.75}
                    >
                      <Ionicons
                        name={selected ? "checkbox" : "square-outline"}
                        size={16}
                        color={selected ? colors.accent : colors.textTertiary}
                      />
                      <Text
                        style={[
                          styles.payorChoiceText,
                          selected && styles.payorChoiceTextActive,
                        ]}
                        numberOfLines={1}
                      >
                        {member.name || member.user?.name || "Payor"}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
                <Text style={styles.payorChoiceHint}>
                  Select up to 3 payors.
                </Text>
              </View>
            )}

            <TouchableOpacity
              style={[
                styles.waterSaveButton,
                savingWaterPreference && styles.waterSaveButtonDisabled,
              ]}
              onPress={saveWaterPayorPreference}
              disabled={savingWaterPreference}
              activeOpacity={0.8}
            >
              {savingWaterPreference ? (
                <ActivityIndicator color={colors.textOnAccent} />
              ) : (
                <>
                  <Ionicons
                    name="save-outline"
                    size={16}
                    color={colors.textOnAccent}
                  />
                  <Text style={styles.waterSaveText}>Save Water Split</Text>
                </>
              )}
            </TouchableOpacity>
          </View>
        )}

        {/* Select room prompt */}
        {!selectedRoom && rooms.length > 0 && (
          <View style={styles.contentPadding}>
            <View style={styles.emptyCard}>
              <View
                style={[
                  styles.emptyIconWrap,
                  { backgroundColor: colors.accentLight },
                ]}
              >
                <Ionicons name="home-outline" size={32} color={colors.accent} />
              </View>
              <Text style={styles.emptyTitle}>Select a Room</Text>
              <Text style={styles.emptySub}>
                Choose a room above to mark attendance.
              </Text>
            </View>
          </View>
        )}

        {/* ─── MAIN CONTENT ─── */}
        {selectedRoom && canMarkPresence ? (
          <>
            {/* Billing Period Strip */}
            {selectedRoom?.billing?.start && selectedRoom?.billing?.end && (
              <View style={styles.billingStrip}>
                <View style={styles.billingStripAccent} />
                <Ionicons name="time-outline" size={14} color={colors.accent} />
                <Text style={styles.billingStripText}>
                  <Text style={styles.billingStripLabel}>Billing Period </Text>
                  {new Date(selectedRoom.billing.start).toLocaleDateString(
                    "en-US",
                    {
                      month: "short",
                      day: "numeric",
                    },
                  )}
                  {" – "}
                  {new Date(selectedRoom.billing.end).toLocaleDateString(
                    "en-US",
                    {
                      month: "short",
                      day: "numeric",
                      year: "numeric",
                    },
                  )}
                </Text>
              </View>
            )}

            {/* ─── STATS ROW ─── */}
            <View style={styles.statsRowCompact}>
              <View
                style={[
                  styles.statBox,
                  { backgroundColor: colors.actionPresenceBg },
                ]}
              >
                <View
                  style={[
                    styles.statIconWrap,
                    { backgroundColor: colors.accentSurface },
                  ]}
                >
                  <Ionicons
                    name="checkmark-done"
                    size={18}
                    color={colors.actionPresenceIcon}
                  />
                </View>
                <Text style={styles.statNum}>{markedDates.length}</Text>
                <Text style={styles.statLabel}>Days Marked</Text>
              </View>
              <View
                style={[
                  styles.statBox,
                  { backgroundColor: colors.actionRoomInfoBg },
                ]}
              >
                <View
                  style={[
                    styles.statIconWrap,
                    { backgroundColor: colors.accentSurface },
                  ]}
                >
                  <Ionicons
                    name="water-outline"
                    size={18}
                    color={colors.actionRoomInfoIcon}
                  />
                </View>
                <Text style={styles.statNum}>
                  ₱{(markedDates.length * 5).toFixed(0)}
                </Text>
                <Text style={styles.statLabel}>Est. Water Bill</Text>
              </View>
              <View
                style={[
                  styles.statBox,
                  { backgroundColor: colors.actionPayBillsBg },
                ]}
              >
                <View
                  style={[
                    styles.statIconWrap,
                    { backgroundColor: colors.accentSurface },
                  ]}
                >
                  <Ionicons
                    name="trending-up-outline"
                    size={18}
                    color={colors.actionPayBillsIcon}
                  />
                </View>
                <Text style={styles.statNum}>{attendanceRate}%</Text>
                <Text style={styles.statLabel}>Attendance</Text>
              </View>
            </View>

            {/* ─── QUICK ACTIONS CARD ─── */}
            <View style={styles.card}>
              <View style={styles.cardHeader}>
                <Ionicons
                  name="flash-outline"
                  size={16}
                  color={colors.accent}
                />
                <Text style={styles.cardTitle}>Quick Actions</Text>
              </View>

              {/* Bulk action row */}
              <View style={styles.bulkRow}>
                <TouchableOpacity
                  style={styles.bulkBtn}
                  onPress={() => {
                    if (!hasActiveCycle) {
                      showToast(
                        "No active billing cycle. Contact your admin.",
                        "info",
                      );
                      return;
                    }
                    markAllCurrentMonth();
                  }}
                  disabled={markingMultiple || !hasActiveCycle}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.bulkIcon,
                      { backgroundColor: colors.infoBg },
                    ]}
                  >
                    <Ionicons
                      name="calendar-outline"
                      size={15}
                      color={colors.info}
                    />
                  </View>
                  <View>
                    <Text style={styles.bulkBtnLabel}>All Month</Text>
                    <Text style={styles.bulkBtnSub}>Every day</Text>
                  </View>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.bulkBtn}
                  onPress={() => {
                    if (!hasActiveCycle) {
                      showToast(
                        "No active billing cycle. Contact your admin.",
                        "info",
                      );
                      return;
                    }
                    markWorkdaysCurrentMonth();
                  }}
                  disabled={markingMultiple || !hasActiveCycle}
                  activeOpacity={0.75}
                >
                  <View
                    style={[
                      styles.bulkIcon,
                      { backgroundColor: colors.successBg },
                    ]}
                  >
                    <Ionicons
                      name="briefcase-outline"
                      size={15}
                      color={colors.success}
                    />
                  </View>
                  <View>
                    <Text style={styles.bulkBtnLabel}>Workdays</Text>
                    <Text style={styles.bulkBtnSub}>Mon – Fri</Text>
                  </View>
                </TouchableOpacity>
              </View>

              {/* Tip */}
              <View style={styles.tipRow}>
                <Ionicons
                  name="finger-print-outline"
                  size={14}
                  color={colors.accent}
                />
                <Text style={styles.tipText}>
                  Tap a date to toggle · Long-press to start a range
                </Text>
              </View>
            </View>

            {/* No cycle banner */}
            {!hasActiveCycle && (
              <View style={styles.warnBanner}>
                <Ionicons
                  name="warning-outline"
                  size={16}
                  color={colors.warning}
                />
                <Text style={styles.warnText}>
                  No active billing cycle. Attendance marking is disabled.
                </Text>
              </View>
            )}

            {/* ─── CALENDAR CARD ─── */}
            <View style={styles.card}>
              <View style={styles.calendarNav}>
                <TouchableOpacity
                  style={[
                    styles.navBtn,
                    !canGoPrevMonth && styles.navBtnDisabled,
                  ]}
                  onPress={() => {
                    if (!canGoPrevMonth) return;
                    setCurrentMonth(
                      new Date(
                        currentMonth.getFullYear(),
                        currentMonth.getMonth() - 1,
                      ),
                    );
                  }}
                  disabled={!canGoPrevMonth}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="chevron-back"
                    size={18}
                    color={canGoPrevMonth ? colors.accent : colors.textTertiary}
                  />
                </TouchableOpacity>

                <Text style={styles.monthLabel}>{monthName}</Text>

                <TouchableOpacity
                  style={[
                    styles.navBtn,
                    !canGoNextMonth && styles.navBtnDisabled,
                  ]}
                  onPress={() => {
                    if (!canGoNextMonth) return;
                    setCurrentMonth(
                      new Date(
                        currentMonth.getFullYear(),
                        currentMonth.getMonth() + 1,
                      ),
                    );
                  }}
                  disabled={!canGoNextMonth}
                  activeOpacity={0.7}
                >
                  <Ionicons
                    name="chevron-forward"
                    size={18}
                    color={canGoNextMonth ? colors.accent : colors.textTertiary}
                  />
                </TouchableOpacity>
              </View>

              {/* Week headers */}
              <View style={styles.weekRow}>
                {["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"].map((d, i) => (
                  <View key={i} style={styles.weekCell}>
                    <Text
                      style={[
                        styles.weekText,
                        (i === 0 || i === 6) && styles.weekTextWeekend,
                      ]}
                    >
                      {d}
                    </Text>
                  </View>
                ))}
              </View>

              {/* Day grid */}
              <View style={styles.dayGrid}>
                {calendarDays.map((date, index) => {
                  if (!date) return <View key={index} style={styles.dayCell} />;

                  const markable = isDateMarkable(date);
                  const marked = isDateMarked(date);
                  const todayFlag = isToday(date);
                  const dateYMD = formatToYMD(date);
                  const isRangeStart =
                    rangeStartDate && dateYMD === rangeStartDate;

                  return (
                    <TouchableOpacity
                      key={index}
                      style={[
                        styles.dayCell,
                        todayFlag && styles.todayCell,
                        marked && !todayFlag && styles.markedCell,
                        marked && todayFlag && styles.markedTodayCell,
                        isRangeStart && styles.rangeCell,
                        !markable && styles.dimCell,
                      ]}
                      onPress={() => {
                        if (!markable) return;
                        if (rangeStartDate) {
                          markDateRange(new Date(rangeStartDate), date);
                        } else {
                          markPresence(date);
                        }
                      }}
                      onLongPress={() => {
                        if (markable)
                          setRangeStartDate(rangeStartDate ? null : dateYMD);
                      }}
                      disabled={!markable}
                      activeOpacity={0.65}
                    >
                      <Text
                        style={[
                          styles.dayNum,
                          todayFlag && styles.todayNum,
                          marked && styles.markedNum,
                          !markable && styles.dimText,
                          isRangeStart && styles.rangeNum,
                        ]}
                      >
                        {date.getDate()}
                      </Text>
                      {marked && (
                        <View
                          style={[
                            styles.markDot,
                            todayFlag && styles.markDotToday,
                          ]}
                        />
                      )}
                      {isRangeStart && (
                        <View style={styles.rangePip}>
                          <Ionicons
                            name="flag"
                            size={7}
                            color={colors.textOnAccent}
                          />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>

              {/* Legend */}
              <View style={styles.legendRow}>
                {[
                  { color: colors.accentLight, label: "Today" },
                  { color: colors.successBg, label: "Marked" },
                  { color: colors.warningBg, label: "Range" },
                  { color: colors.skeleton, label: "N/A" },
                ].map((item) => (
                  <View key={item.label} style={styles.legendItem}>
                    <View
                      style={[
                        styles.legendDot,
                        { backgroundColor: item.color },
                      ]}
                    />
                    <Text style={styles.legendLabel}>{item.label}</Text>
                  </View>
                ))}
              </View>
            </View>
          </>
        ) : selectedRoom &&
          selectedRoom?.cycleStatus === "cycle_closed" &&
          !userPaidStatus ? (
          <StateCard
            icon="lock-closed"
            iconBg={colors.errorBg}
            iconColor={colors.error}
            title="Billing Cycle Closed"
            message="This billing cycle has been closed by your host. Attendance marking is no longer available. Please contact your host to settle your outstanding payment."
            colors={colors}
          />
        ) : selectedRoom && userPaidStatus ? (
          <StateCard
            icon="checkmark-circle"
            iconBg={colors.successBg}
            iconColor={colors.success}
            title="All Bills Paid"
            message="You have paid all your bills for this billing period. Attendance marking is locked."
            colors={colors}
          />
        ) : selectedRoom && isFixedMonthlyWater ? (
          <StateCard
            icon="water"
            iconBg={colors.infoBg}
            iconColor={colors.info}
            title="Fixed Monthly Billing"
            message="Your host has set a fixed monthly water bill for this room. Attendance tracking is not required — your water charge is already calculated."
            colors={colors}
          />
        ) : selectedRoom && hasPendingPayment ? (
          <StateCard
            icon="hourglass-outline"
            iconBg={colors.warningBg}
            iconColor={colors.warning}
            title="Awaiting Verification"
            message="Your payment has been submitted and is pending verification by your host. Attendance marking will be available again once your payment is verified."
            colors={colors}
          />
        ) : selectedRoom ? (
          <StateCard
            icon="time-outline"
            iconBg={colors.actionPresenceBg}
            iconColor={colors.accent}
            title="No Active Billing Cycle"
            message="Waiting for your admin to set billing details for this billing period."
            colors={colors}
          />
        ) : null}

        {rooms.length === 0 && (
          <StateCard
            icon="home-outline"
            iconBg={colors.cardAlt}
            iconColor={colors.textTertiary}
            title="No Rooms Joined"
            message="Join a room from Home to start marking attendance."
            colors={colors}
          />
        )}

        <View style={{ height: 36 }} />
      </ScrollViewWithDetection>
    </>
  );
};

// ─── Reusable state card component ────────────────────────────────────────────
const StateCard = ({ icon, iconBg, iconColor, title, message, colors }) => {
  const styles = createStyles(colors);
  return (
    <View style={styles.stateCard}>
      <View style={[styles.stateIconWrap, { backgroundColor: iconBg }]}>
        <Ionicons name={icon} size={30} color={iconColor} />
      </View>
      <Text style={styles.stateTitle}>{title}</Text>
      <Text style={styles.stateSub}>{message}</Text>
    </View>
  );
};

// ─── Styles ───────────────────────────────────────────────────────────────────
const createStyles = (colors, insets = { top: 0, bottom: 0 }) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.background,
    },
    contentPadding: {
      paddingHorizontal: 16,
    },
    loadingScrollContent: {
      paddingBottom: insets.bottom + 48,
    },
    centerContainer: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.background,
    },
    loadingOnHeader: {
      backgroundColor: "rgba(255,255,255,0.22)",
    },
    loadingHeaderIcon: {
      width: 44,
      height: 44,
      borderRadius: 14,
    },
    loadingHeaderTitle: {
      width: 116,
      height: 24,
      borderRadius: 8,
    },
    loadingHeaderSubtitle: {
      width: "62%",
      height: 13,
      marginTop: 8,
      borderRadius: 7,
    },
    loadingHeaderFootnote: {
      width: "92%",
      height: 13,
      marginTop: 18,
      borderRadius: 7,
    },
    loadingHeaderFootnoteShort: {
      width: "68%",
      height: 13,
      marginTop: 8,
      borderRadius: 7,
    },
    loadingStatusChip: {
      width: 94,
      height: 30,
      borderRadius: 999,
    },
    loadingStatusChipWide: {
      width: 128,
      height: 30,
      borderRadius: 999,
    },
    loadingRoomPill: {
      width: 118,
      height: 40,
      borderRadius: 20,
    },
    loadingSummaryEyebrow: {
      width: 118,
      height: 11,
      borderRadius: 6,
      marginBottom: 12,
    },
    loadingSummaryTitle: {
      width: 156,
      height: 18,
      borderRadius: 7,
    },
    loadingSummaryValue: {
      width: 118,
      height: 34,
      borderRadius: 11,
      marginTop: 12,
    },
    loadingSummaryText: {
      width: "92%",
      height: 14,
      borderRadius: 7,
      marginTop: 12,
    },
    loadingBadge: {
      width: 82,
      height: 30,
      borderRadius: 999,
    },
    loadingBadgeWide: {
      width: 110,
      height: 30,
      borderRadius: 999,
    },
    loadingStatValue: {
      width: 52,
      height: 20,
      borderRadius: 8,
    },
    loadingStatLabel: {
      width: 76,
      height: 11,
      borderRadius: 6,
      marginTop: 9,
    },
    loadingCardIcon: {
      width: 18,
      height: 18,
      borderRadius: 9,
    },
    loadingCardTitle: {
      width: 128,
      height: 18,
      borderRadius: 7,
    },
    loadingPrimaryButton: {
      height: 52,
      borderRadius: 16,
    },
    loadingBulkButton: {
      flex: 1,
      height: 64,
      borderRadius: 16,
    },
    loadingTipLine: {
      width: "100%",
      height: 34,
      borderRadius: 14,
      marginTop: 12,
    },
    loadingNavButton: {
      width: 40,
      height: 40,
      borderRadius: 14,
    },
    loadingMonthLabel: {
      width: 132,
      height: 18,
      borderRadius: 8,
    },
    loadingWeekLabel: {
      width: 20,
      height: 11,
      borderRadius: 6,
    },
    loadingDayCell: {
      width: 28,
      height: 28,
      borderRadius: 10,
    },
    header: {
      paddingHorizontal: 20,
      // paddingTop: insets.top + 14,
      paddingTop: 20,
      paddingBottom: 60,
      backgroundColor: colors.headerBg,
      borderBottomLeftRadius: 32,
      borderBottomRightRadius: 32,
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
      maxWidth: "92%",
    },
    headerStatusRow: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 16,
    },
    headerStatusChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: "rgba(255,255,255,0.12)",
      paddingHorizontal: 12,
      paddingVertical: 8,
      borderRadius: 999,
    },
    headerStatusChipText: {
      fontSize: 12,
      fontWeight: "700",
      color: "#d8efe8",
    },
    roomSelectorContainer: {
      backgroundColor: colors.card,
      paddingVertical: 14,
      marginHorizontal: 16,
      marginTop: -30,
      borderRadius: 20,
      shadowColor: "#000",
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.12,
      shadowRadius: 12,
      elevation: 6,
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
    summarySubtext: {
      fontSize: 13,
      color: colors.textSecondary,
      lineHeight: 19,
      marginTop: 10,
    },
    summaryBadgeStack: {
      gap: 8,
      alignItems: "flex-end",
      maxWidth: 128,
    },
    summaryBadge: {
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
      backgroundColor: colors.cardAlt,
    },
    summaryBadgeText: {
      fontSize: 11,
      fontWeight: "800",
      color: colors.textSecondary,
      letterSpacing: 0.3,
      textTransform: "uppercase",
      textAlign: "right",
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

    // ── Hero Header ──
    waterSplitCard: {
      marginHorizontal: 16,
      marginTop: 14,
      backgroundColor: colors.card,
      borderRadius: 22,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.borderLight,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 14,
      elevation: 3,
    },
    waterSplitHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginBottom: 14,
    },
    waterSplitIcon: {
      width: 40,
      height: 40,
      borderRadius: 14,
      backgroundColor: colors.accentLight,
      justifyContent: "center",
      alignItems: "center",
    },
    waterSplitTitle: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
    },
    waterSplitSub: {
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 2,
      lineHeight: 17,
    },
    waterModeRow: {
      flexDirection: "row",
      gap: 10,
    },
    waterModeChip: {
      flex: 1,
      minHeight: 44,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.borderLight,
      backgroundColor: colors.cardAlt,
      flexDirection: "row",
      alignItems: "center",
      justifyContent: "center",
      gap: 7,
      paddingHorizontal: 10,
    },
    waterModeChipActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    waterModeText: {
      fontSize: 12,
      fontWeight: "800",
      color: colors.textSecondary,
      textAlign: "center",
    },
    waterModeTextActive: {
      color: colors.textOnAccent,
    },
    payorChoiceWrap: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginTop: 12,
    },
    payorChoiceChip: {
      maxWidth: "48%",
      flexGrow: 1,
      minHeight: 42,
      borderRadius: 14,
      borderWidth: 1,
      borderColor: colors.borderLight,
      backgroundColor: colors.cardAlt,
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      paddingHorizontal: 11,
    },
    payorChoiceChipActive: {
      borderColor: colors.accent,
      backgroundColor: colors.accentLight,
    },
    payorChoiceText: {
      flex: 1,
      fontSize: 12,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    payorChoiceTextActive: {
      color: colors.accent,
    },
    payorChoiceHint: {
      width: "100%",
      fontSize: 11,
      color: colors.textTertiary,
      fontWeight: "600",
      marginTop: 2,
    },
    waterSaveButton: {
      height: 46,
      borderRadius: 15,
      backgroundColor: colors.accent,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 8,
      marginTop: 14,
    },
    waterSaveButtonDisabled: {
      opacity: 0.6,
    },
    waterSaveText: {
      fontSize: 14,
      fontWeight: "800",
      color: colors.textOnAccent,
    },

    heroHeader: {
      backgroundColor: colors.card,
      paddingHorizontal: 20,
      paddingTop: 18,
      paddingBottom: 16,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 3,
    },
    heroHeaderInner: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
    },
    heroLeft: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    heroIconWrap: {
      width: 44,
      height: 44,
      borderRadius: 14,
      backgroundColor: colors.actionPresenceBg,
      justifyContent: "center",
      alignItems: "center",
    },
    heroTitle: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.text,
      letterSpacing: -0.3,
    },
    heroSub: {
      fontSize: 12,
      color: colors.textTertiary,
      marginTop: 1,
    },
    heroBadge: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
      backgroundColor: colors.successBg,
      paddingHorizontal: 11,
      paddingVertical: 6,
      borderRadius: 24,
    },
    heroBadgeText: {
      fontSize: 12,
      fontWeight: "700",
      color: colors.success,
    },

    // ── Room Pills ──
    roomPillsWrap: {
      backgroundColor: colors.card,
      paddingVertical: 12,
      paddingHorizontal: 16,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 1 },
      shadowOpacity: 0.04,
      shadowRadius: 4,
      elevation: 1,
    },
    roomPillsRow: {
      flexDirection: "row",
      gap: 10,
      paddingHorizontal: 20,
    },
    roomPill: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderRadius: 20,
      backgroundColor: colors.cardAlt,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    roomPillActive: {
      backgroundColor: colors.accent,
      borderColor: colors.accent,
    },
    roomPillText: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.textSecondary,
    },
    roomPillTextActive: {
      color: colors.textOnAccent,
    },

    // ── Billing Strip ──
    billingStrip: {
      display: "none",
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 16,
      marginTop: 14,
      paddingVertical: 11,
      paddingHorizontal: 16,
      backgroundColor: colors.card,
      borderRadius: 18,
      overflow: "hidden",
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 2 },
      shadowOpacity: 0.06,
      shadowRadius: 8,
      elevation: 2,
    },
    billingStripAccent: {
      position: "absolute",
      left: 0,
      top: 0,
      bottom: 0,
      width: 4,
      backgroundColor: colors.accent,
    },
    billingStripLabel: {
      fontWeight: "600",
      color: colors.textSecondary,
    },
    billingStripText: {
      fontSize: 12,
      color: colors.textSecondary,
      flex: 1,
    },

    // ── Stats Row ──
    statsRow: {
      flexDirection: "row",
      gap: 10,
      marginHorizontal: 16,
      marginTop: 14,
    },
    statsRowCompact: {
      display: "none",
    },
    statBox: {
      flex: 1,
      alignItems: "center",
      borderRadius: 20,
      paddingVertical: 16,
      paddingHorizontal: 6,
      gap: 4,
    },
    statIconWrap: {
      width: 38,
      height: 38,
      borderRadius: 12,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 4,
    },
    statNum: {
      fontSize: 20,
      fontWeight: "700",
      color: colors.text,
      letterSpacing: -0.5,
    },
    statLabel: {
      fontSize: 10,
      color: colors.textTertiary,
      textAlign: "center",
      fontWeight: "500",
    },

    // ── Cards ──
    card: {
      marginHorizontal: 16,
      marginTop: 18,
      backgroundColor: colors.card,
      borderRadius: 20,
      padding: 18,
      borderWidth: 1,
      borderColor: colors.borderLight,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.08,
      shadowRadius: 14,
      elevation: 3,
    },
    cardHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      marginBottom: 14,
    },
    cardTitle: {
      fontSize: 16,
      fontWeight: "800",
      color: colors.text,
      letterSpacing: -0.1,
    },

    // ── Primary Button ──
    primaryBtn: {
      backgroundColor: colors.accent,
      borderRadius: 16,
      paddingVertical: 16,
      flexDirection: "row",
      justifyContent: "center",
      alignItems: "center",
      gap: 10,
      shadowColor: colors.accent,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.3,
      shadowRadius: 10,
      elevation: 4,
    },
    primaryBtnDisabled: {
      opacity: 0.55,
    },
    primaryBtnIconWrap: {
      opacity: 0.9,
    },
    primaryBtnText: {
      color: colors.textOnAccent,
      fontWeight: "700",
      fontSize: 15,
      letterSpacing: -0.2,
    },

    // ── Bulk Actions ──
    bulkRow: {
      flexDirection: "row",
      gap: 10,
      marginTop: 10,
    },
    bulkBtn: {
      flex: 1,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
      backgroundColor: colors.cardAlt,
      borderRadius: 16,
      paddingVertical: 13,
      paddingHorizontal: 13,
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    bulkIcon: {
      width: 36,
      height: 36,
      borderRadius: 11,
      justifyContent: "center",
      alignItems: "center",
    },
    bulkBtnLabel: {
      fontSize: 13,
      fontWeight: "700",
      color: colors.text,
    },
    bulkBtnSub: {
      fontSize: 11,
      color: colors.textTertiary,
      marginTop: 1,
    },

    // ── Tip Row ──
    tipRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 7,
      marginTop: 12,
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.accentLight,
      borderRadius: 14,
    },
    tipText: {
      flex: 1,
      fontSize: 11,
      color: colors.accent,
      fontWeight: "600",
    },

    // ── Warning Banner ──
    warnBanner: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      marginHorizontal: 16,
      marginTop: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      backgroundColor: colors.warningBg,
      borderRadius: 16,
    },
    warnText: {
      flex: 1,
      fontSize: 12,
      color: colors.warning,
      fontWeight: "600",
    },

    // ── Calendar ──
    calendarNav: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginBottom: 16,
    },
    navBtn: {
      width: 40,
      height: 40,
      borderRadius: 14,
      backgroundColor: colors.cardAlt,
      justifyContent: "center",
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.borderLight,
    },
    navBtnDisabled: {
      opacity: 0.3,
    },
    monthLabel: {
      fontSize: 17,
      fontWeight: "800",
      color: colors.text,
      letterSpacing: -0.3,
    },
    weekRow: {
      flexDirection: "row",
      marginBottom: 8,
    },
    weekCell: {
      flex: 1,
      alignItems: "center",
      paddingVertical: 4,
    },
    weekText: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textTertiary,
      letterSpacing: 0.3,
    },
    weekTextWeekend: {
      color: colors.textSecondary,
    },
    dayGrid: {
      flexDirection: "row",
      flexWrap: "wrap",
    },
    dayCell: {
      width: "14.28%",
      aspectRatio: 1,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 4,
      borderRadius: 12,
      position: "relative",
    },
    todayCell: {
      backgroundColor: colors.accentLight,
    },
    markedCell: {
      backgroundColor: colors.successBg,
    },
    markedTodayCell: {
      backgroundColor: colors.successBg,
    },
    rangeCell: {
      backgroundColor: colors.warningBg,
    },
    dimCell: {
      opacity: 0.28,
    },
    dayNum: {
      fontSize: 13,
      fontWeight: "600",
      color: colors.text,
    },
    todayNum: {
      color: colors.accent,
      fontWeight: "800",
    },
    markedNum: {
      color: colors.success,
      fontWeight: "700",
    },
    rangeNum: {
      color: colors.warning,
      fontWeight: "700",
    },
    dimText: {
      color: colors.textTertiary,
    },
    markDot: {
      position: "absolute",
      bottom: 3,
      width: 4,
      height: 4,
      borderRadius: 2,
      backgroundColor: colors.success,
    },
    markDotToday: {
      backgroundColor: colors.accent,
    },
    rangePip: {
      position: "absolute",
      top: 2,
      right: 3,
      width: 13,
      height: 13,
      borderRadius: 7,
      backgroundColor: colors.warning,
      justifyContent: "center",
      alignItems: "center",
    },

    // ── Legend ──
    legendRow: {
      flexDirection: "row",
      justifyContent: "center",
      gap: 14,
      marginTop: 14,
      paddingTop: 12,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.divider,
    },
    legendItem: {
      flexDirection: "row",
      alignItems: "center",
      gap: 5,
    },
    legendDot: {
      width: 9,
      height: 9,
      borderRadius: 5,
    },
    legendLabel: {
      fontSize: 11,
      color: colors.textTertiary,
      fontWeight: "500",
    },

    // ── State Cards (empty/locked states) ──
    stateCard: {
      marginHorizontal: 16,
      marginTop: 18,
      backgroundColor: colors.card,
      borderRadius: 22,
      padding: 30,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.borderLight,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.07,
      shadowRadius: 16,
      elevation: 3,
    },
    stateIconWrap: {
      width: 68,
      height: 68,
      borderRadius: 22,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 16,
    },
    stateTitle: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.text,
      textAlign: "center",
      letterSpacing: -0.3,
    },
    stateSub: {
      fontSize: 13,
      color: colors.textTertiary,
      marginTop: 8,
      textAlign: "center",
      lineHeight: 19,
    },

    // ── Legacy aliases used by <StateCard> reuse ──
    emptyCard: {
      marginTop: 20,
      backgroundColor: colors.card,
      borderRadius: 22,
      padding: 30,
      alignItems: "center",
      borderWidth: 1,
      borderColor: colors.borderLight,
      shadowColor: colors.shadow,
      shadowOffset: { width: 0, height: 4 },
      shadowOpacity: 0.07,
      shadowRadius: 16,
      elevation: 3,
    },
    emptyIconWrap: {
      width: 68,
      height: 68,
      borderRadius: 22,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 16,
    },
    emptyTitle: {
      fontSize: 16,
      fontWeight: "700",
      color: colors.text,
      textAlign: "center",
    },
    emptySub: {
      fontSize: 13,
      color: colors.textTertiary,
      marginTop: 8,
      textAlign: "center",
      lineHeight: 19,
    },
  });

export default PresenceScreen;
