import React, { useState, useEffect, useCallback, useMemo } from "react";
import ModalBottomSpacer from "../../components/ModalBottomSpacer";
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Alert,
  Modal,
  TextInput,
  RefreshControl,
  Platform,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useRoute } from "@react-navigation/native";
import { apiService } from "../../services/apiService";
import { ActivityIndicator } from "react-native";
import { useTheme } from "../../theme/ThemeContext";
import { ScrollViewWithDetection } from "../../components/ScrollDetectionWrappers";
import HomeSpaceLoader from "../../components/SpaceLoader";

const getBillMeta = (c) => ({
  rent: { icon: "home", color: c.success, bg: c.successBg, label: "Rent" },
  electricity: {
    icon: "flash",
    color: c.electricityColor,
    bg: c.accentSurface,
    label: "Electricity",
  },
  water: { icon: "water", color: c.waterColor, bg: c.infoBg, label: "Water" },
  internet: {
    icon: "wifi",
    color: c.internetColor,
    bg: c.purpleBg,
    label: "Internet",
  },
  custom_charges: {
    icon: "receipt",
    color: c.textSecondary,
    bg: c.cardAlt,
    label: "Additional",
  },
});

const formatCurrency = (value) =>
  `\u20B1${(Number(value) || 0).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;

const AdminAdjustmentsScreen = ({ navigation }) => {
  const { colors } = useTheme();
  const styles = createStyles(colors);
  const BILL_META = getBillMeta(colors);

  const route = useRoute();
  const { room, cycleId } = route.params || {};

  const [breakdown, setBreakdown] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [adjustmentModalVisible, setAdjustmentModalVisible] = useState(false);
  const [refundModalVisible, setRefundModalVisible] = useState(false);
  const [noteModalVisible, setNoteModalVisible] = useState(false);
  const [actualCycleId, setActualCycleId] = useState(cycleId);

  // Form states
  const [adjustmentAmount, setAdjustmentAmount] = useState("");
  const [adjustmentReason, setAdjustmentReason] = useState("");
  const [refundAmount, setRefundAmount] = useState("");
  const [refundBillType, setRefundBillType] = useState("rent"); // rent, electricity, water, internet
  const [refundReason, setRefundReason] = useState("");
  const [noteText, setNoteText] = useState("");
  const [noteBillType, setNoteBillType] = useState("general");

  const fetchBreakdown = useCallback(async () => {
    try {
      setLoading(true);

      // If cycleId not provided, try to get active cycle from the room
      let idToUse = actualCycleId;
      if (!idToUse && room) {
        try {
          const cycleResponse = await apiService.get(
            `/api/v2/billing-cycles/room/${room.id || room._id}/active`,
          );
          const cycleObj = cycleResponse.billingCycle || cycleResponse.data;
          if (cycleObj?.id || cycleObj?._id) {
            idToUse = cycleObj.id || cycleObj._id;
            setActualCycleId(idToUse);
          }
        } catch (error) {
          console.error("Error fetching active cycle:", error);
        }
      }

      if (!idToUse) {
        Alert.alert("Error", "No active billing cycle found");
        setLoading(false);
        return;
      }

      const response = await apiService.get(
        `/api/v2/admin/billing/breakdown/${idToUse}`,
      );
      setBreakdown(response.breakdown);
    } catch (error) {
      console.error("Error fetching breakdown:", error);
      Alert.alert("Error", "Failed to load billing details");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [actualCycleId, cycleId, room?.id, room?._id]);

  useEffect(() => {
    fetchBreakdown();
  }, [fetchBreakdown]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    fetchBreakdown();
  }, [fetchBreakdown]);

  const handleAdjustCharge = async () => {
    if (!selectedMember || !adjustmentAmount || !adjustmentReason.trim()) {
      Alert.alert("Error", "Enter the fixed amount and reason");
      return;
    }

    const targetAmount = Number(adjustmentAmount);
    if (!Number.isFinite(targetAmount) || targetAmount < 0) {
      Alert.alert("Error", "Enter a valid amount");
      return;
    }

    try {
      setLoading(true);
      await apiService.post(
        `/api/v2/admin/billing/set-member-total/${actualCycleId}/${selectedMember.userId}`,
        {
          targetAmount,
          reason: adjustmentReason,
        },
      );

      Alert.alert("Success", "Payor total adjusted and redistributed!");
      setAdjustmentModalVisible(false);
      setAdjustmentAmount("");
      setAdjustmentReason("");
      setSelectedMember(null);
      fetchBreakdown();
    } catch (error) {
      Alert.alert(
        "Error",
        error.response?.data?.message || "Adjustment failed",
      );
    } finally {
      setLoading(false);
    }
  };

  const handleRefund = async () => {
    if (!selectedMember || !refundAmount || !refundReason.trim()) {
      Alert.alert("Error", "Please fill all fields");
      return;
    }

    try {
      setLoading(true);
      await apiService.post(`/api/v2/admin/billing/refund/${actualCycleId}`, {
        memberId: selectedMember.userId,
        amount: parseFloat(refundAmount),
        billType: refundBillType,
        reason: refundReason,
      });

      Alert.alert("Success", "Refund processed successfully!");
      setRefundModalVisible(false);
      setRefundAmount("");
      setRefundReason("");
      setSelectedMember(null);
      fetchBreakdown();
    } catch (error) {
      Alert.alert("Error", error.response?.data?.message || "Refund failed");
    } finally {
      setLoading(false);
    }
  };

  const handleAddNote = async () => {
    if (!selectedMember || !noteText.trim()) {
      Alert.alert("Error", "Please enter a note");
      return;
    }

    try {
      setLoading(true);
      await apiService.post(
        `/api/v2/admin/billing/add-note/${actualCycleId}/${selectedMember.userId}`,
        {
          note: noteText,
          billType: noteBillType,
        },
      );

      Alert.alert("Success", "Note added successfully!");
      setNoteModalVisible(false);
      setNoteText("");
      setSelectedMember(null);
    } catch (error) {
      Alert.alert(
        "Error",
        error.response?.data?.message || "Failed to add note",
      );
    } finally {
      setLoading(false);
    }
  };

  const chargeEntries = [
    { key: "rent", field: "rentShare" },
    { key: "electricity", field: "electricityShare" },
    { key: "water", field: "waterShare" },
    { key: "internet", field: "internetShare" },
    { key: "custom_charges", field: "customChargesShare" },
  ];

  const payerMembers = useMemo(
    () =>
      (breakdown?.memberBreakdown || []).filter(
        (member) => member.isPayer !== false,
      ),
    [breakdown?.memberBreakdown],
  );

  const paidMembersCount = useMemo(
    () => payerMembers.filter((member) => member.allPaid).length,
    [payerMembers],
  );

  const totalDueAmount = useMemo(
    () =>
      payerMembers.reduce(
        (sum, member) => sum + Number(member.totalDue || 0),
        0,
      ),
    [payerMembers],
  );

  const renderMemberCard = (member) => {
    const isPaid = member.allPaid;
    const initials = (member.memberName || "?")
      .split(" ")
      .map((w) => w[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);

    return (
      <View style={styles.memberCard}>
        {/* Header */}
        <View style={styles.memberHeader}>
          <View style={styles.memberLeft}>
            <View
              style={[
                styles.memberAvatar,
                {
                  backgroundColor: isPaid
                    ? colors.successBg
                    : colors.accentSurface,
                },
              ]}
            >
              <Text
                style={[
                  styles.avatarText,
                  { color: isPaid ? colors.success : "#b38604" },
                ]}
              >
                {initials}
              </Text>
            </View>
            <View style={styles.memberIdentity}>
              <Text style={styles.memberName} numberOfLines={1}>
                {member.memberName}
              </Text>
              <View style={styles.presenceRow}>
                <Ionicons
                  name="calendar-outline"
                  size={12}
                  color={colors.textTertiary}
                />
                <Text style={styles.presenceText}>
                  {member.presenceDays} days present
                </Text>
              </View>
            </View>
          </View>
          <View style={styles.memberRight}>
            <Text
              style={styles.memberTotal}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.68}
            >
              ₱{(member.totalDue || 0).toFixed(2)}
            </Text>
            {isPaid && (
              <View style={styles.paidChip}>
                <Ionicons
                  name="checkmark-circle"
                  size={12}
                  color={colors.success}
                />
                <Text style={styles.paidChipText}>Paid</Text>
              </View>
            )}
          </View>
        </View>

        {/* Charge rows with BILL_META icons */}
        <View style={styles.chargesDetails}>
          {chargeEntries.map(({ key, field }) => {
            const meta = BILL_META[key];
            if (
              key === "custom_charges" &&
              (member[field] || 0) === 0 &&
              !member.manualAdjustment
            ) {
              return null;
            }
            return (
              <View key={key} style={styles.chargeRow}>
                <View style={styles.chargeLeft}>
                  <View
                    style={[
                      styles.chargeIconWrap,
                      { backgroundColor: meta.bg },
                    ]}
                  >
                    <Ionicons name={meta.icon} size={13} color={meta.color} />
                  </View>
                  <Text style={styles.chargeLabel}>{meta.label}</Text>
                </View>
                <Text
                  style={styles.chargeValue}
                  numberOfLines={1}
                  adjustsFontSizeToFit
                  minimumFontScale={0.72}
                >
                  ₱{(member[field] || 0).toFixed(2)}
                </Text>
              </View>
            );
          })}
          {/* Total */}
          <View style={styles.chargeTotalRow}>
            <Text style={styles.chargeTotalLabel}>Total Due</Text>
            <Text
              style={styles.chargeTotalValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.72}
            >
              ₱{(member.totalDue || 0).toFixed(2)}
            </Text>
          </View>
          {member.waterShareNote && (
            <View style={styles.chargeNote}>
              <Ionicons name="water" size={12} color={colors.info} />
              <Text style={styles.chargeNoteText}>{member.waterShareNote}</Text>
            </View>
          )}
          {member.manualAdjustment && member.adjustmentMetadata && (
            <View style={styles.adjustmentNote}>
              <Ionicons name="git-compare" size={12} color={colors.accent} />
              <Text style={styles.adjustmentNoteText}>
                Fixed total applied. Redistributed{" "}
                {formatCurrency(
                  member.adjustmentMetadata.redistributed_amount || 0,
                )}
                .
              </Text>
            </View>
          )}
        </View>

        {/* Actions */}
        {isPaid ? (
          <View style={styles.paidNotice}>
            <Ionicons name="lock-closed" size={14} color={colors.success} />
            <Text style={styles.paidNoticeText}>
              Adjustments disabled — fully paid
            </Text>
          </View>
        ) : (
          <View style={styles.actionButtons}>
            <TouchableOpacity
              style={[styles.actionBtn, styles.adjustBtn]}
              activeOpacity={0.7}
              onPress={() => {
                setSelectedMember(member);
                setAdjustmentModalVisible(true);
              }}
            >
              <Ionicons
                name="wallet"
                size={15}
                color={colors.textOnAccent}
              />
              <Text style={styles.actionBtnText}>Set Amount</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.refundBtn]}
              activeOpacity={0.7}
              onPress={() => {
                setSelectedMember(member);
                setRefundModalVisible(true);
              }}
            >
              <Ionicons
                name="arrow-undo"
                size={15}
                color={colors.textOnAccent}
              />
              <Text style={styles.actionBtnText}>Refund</Text>
            </TouchableOpacity>

            <TouchableOpacity
              style={[styles.actionBtn, styles.noteBtn]}
              activeOpacity={0.7}
              onPress={() => {
                setSelectedMember(member);
                setNoteModalVisible(true);
              }}
            >
              <Ionicons name="create" size={15} color={colors.textOnAccent} />
              <Text style={styles.actionBtnText}>Note</Text>
            </TouchableOpacity>
          </View>
        )}
      </View>
    );
  };

  if (loading) {
    return (
      <View style={styles.centerWrap}>
        <View style={styles.centerLoader}>
          <HomeSpaceLoader />
        </View>
      </View>
    );
  }

  return (
    <ScrollViewWithDetection
      style={styles.container}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintcolor={colors.accent}
          colors={["#b38604"]}
        />
      }
    >
      <View style={styles.summaryPanel}>
        <View style={styles.summaryTopRow}>
          <View style={styles.summaryIconWrap}>
            <Ionicons
              name="settings-sharp"
              size={20}
              color={colors.textOnAccent}
            />
          </View>
          <View style={styles.summaryCopy}>
            <Text style={styles.summaryEyebrow} numberOfLines={1}>
              Charge Adjustments
            </Text>
            <Text style={styles.summaryTitle} numberOfLines={1}>
              Cycle #{breakdown?.cycleNumber || "-"}
            </Text>
          </View>
        </View>

        <View style={styles.summaryStatsRow}>
          <View style={styles.summaryStatCard}>
            <Text style={styles.summaryStatValue}>{payerMembers.length}</Text>
            <Text style={styles.summaryStatLabel}>Payors</Text>
          </View>
          <View style={styles.summaryStatCard}>
            <Text
              style={styles.summaryStatValue}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.62}
            >
              {formatCurrency(totalDueAmount)}
            </Text>
            <Text style={styles.summaryStatLabel}>Total Due</Text>
          </View>
          <View style={styles.summaryStatCard}>
            <Text style={styles.summaryStatValue}>{paidMembersCount}</Text>
            <Text style={styles.summaryStatLabel}>Paid</Text>
          </View>
        </View>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Ionicons name="people" size={16} color={colors.accent} />
          <Text style={styles.sectionTitle}>Members</Text>
        </View>
        {payerMembers.length > 0 ? (
          payerMembers.map((member) => (
            <View key={member.userId}>{renderMemberCard(member)}</View>
          ))
        ) : (
          <View style={styles.emptyCard}>
            <View style={styles.emptyIconWrap}>
              <Ionicons name="people-outline" size={32} color={colors.accent} />
            </View>
            <Text style={styles.emptyTitle}>No Members Yet</Text>
            <Text style={styles.emptySubtitle}>
              Charge adjustments will be available once members join the room
              and are marked as payers.
            </Text>
          </View>
        )}
      </View>

      {/* Adjustment Modal */}
      <Modal visible={adjustmentModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View
                style={[
                  styles.modalIconWrap,
                  { backgroundColor: colors.accentSurface },
                ]}
              >
                <Ionicons name="wallet" size={20} color={colors.accent} />
              </View>
              <View>
                <Text style={styles.modalTitle}>Set Payor Total</Text>
                <Text style={styles.modalSubtitle}>
                  {selectedMember?.memberName}
                </Text>
              </View>
            </View>

            <View style={styles.form}>
              <View style={styles.adjustmentInfoBox}>
                <Text style={styles.adjustmentInfoLabel}>Current total</Text>
                <Text style={styles.adjustmentInfoAmount}>
                  {formatCurrency(selectedMember?.totalDue || 0)}
                </Text>
              </View>

              <Text style={styles.formLabel}>Adjustment Amount (₱)</Text>
              <TextInput
                style={styles.input}
                placeholder="Example: 2000"
                keyboardType="decimal-pad"
                value={adjustmentAmount}
                onChangeText={setAdjustmentAmount}
              />

              <Text style={styles.formLabel}>Reason</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Example: Moving out early, agreed fixed share"
                multiline
                numberOfLines={3}
                value={adjustmentReason}
                onChangeText={setAdjustmentReason}
              />

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => {
                    setAdjustmentModalVisible(false);
                    setSelectedMember(null);
                    setAdjustmentAmount("");
                    setAdjustmentReason("");
                  }}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={styles.confirmBtn}
                  onPress={handleAdjustCharge}
                >
                  <Text style={styles.confirmBtnText}>Redistribute</Text>
                </TouchableOpacity>
              </View>
              <ModalBottomSpacer />
            </View>
          </View>
        </View>
      </Modal>

      {/* Refund Modal */}
      <Modal visible={refundModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View
                style={[
                  styles.modalIconWrap,
                  { backgroundColor: colors.warningBg },
                ]}
              >
                <Ionicons
                  name="arrow-undo"
                  size={20}
                  color={colors.electricityColor}
                />
              </View>
              <View>
                <Text style={styles.modalTitle}>Process Refund</Text>
                <Text style={styles.modalSubtitle}>
                  {selectedMember?.memberName}
                </Text>
              </View>
            </View>

            <View style={styles.form}>
              <Text style={styles.formLabel}>Bill Type</Text>
              <View style={styles.typeButtons}>
                {["rent", "electricity", "water", "internet"].map((type) => {
                  const meta = BILL_META[type];
                  const active = refundBillType === type;
                  return (
                    <TouchableOpacity
                      key={type}
                      style={[
                        styles.typeBtn,
                        active && {
                          backgroundColor: meta.bg,
                          borderColor: meta.color,
                        },
                      ]}
                      onPress={() => setRefundBillType(type)}
                    >
                      <Ionicons
                        name={meta.icon}
                        size={14}
                        color={active ? meta.color : "#bbb"}
                      />
                      <Text
                        style={[
                          styles.typeBtnText,
                          active && { color: meta.color },
                        ]}
                      >
                        {meta.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.formLabel}>Refund Amount (₱)</Text>
              <TextInput
                style={styles.input}
                placeholder="Enter refund amount"
                keyboardType="decimal-pad"
                value={refundAmount}
                onChangeText={setRefundAmount}
              />

              <Text style={styles.formLabel}>Reason</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Reason for refund..."
                multiline
                numberOfLines={3}
                value={refundReason}
                onChangeText={setRefundReason}
              />

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => {
                    setRefundModalVisible(false);
                    setSelectedMember(null);
                    setRefundAmount("");
                    setRefundReason("");
                  }}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.confirmBtn,
                    { backgroundColor: colors.electricityColor },
                  ]}
                  onPress={handleRefund}
                >
                  <Text style={styles.confirmBtnText}>Process Refund</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>

      {/* Note Modal */}
      <Modal visible={noteModalVisible} transparent animationType="fade">
        <View style={styles.modalOverlay}>
          <View style={styles.modalContent}>
            <View style={styles.modalHeader}>
              <View
                style={[
                  styles.modalIconWrap,
                  { backgroundColor: colors.purpleBg },
                ]}
              >
                <Ionicons
                  name="create"
                  size={20}
                  color={colors.internetColor}
                />
              </View>
              <View>
                <Text style={styles.modalTitle}>Add Note</Text>
                <Text style={styles.modalSubtitle}>
                  {selectedMember?.memberName}
                </Text>
              </View>
            </View>

            <View style={styles.form}>
              <Text style={styles.formLabel}>Bill Type (Optional)</Text>
              <View style={styles.typeButtons}>
                {["general", "rent", "electricity", "water"].map((type) => {
                  const meta = BILL_META[type] || {
                    icon: "list",
                    color: colors.accent,
                    bg: "#fef8e8",
                    label: "General",
                  };
                  const active = noteBillType === type;
                  return (
                    <TouchableOpacity
                      key={type}
                      style={[
                        styles.typeBtn,
                        active && {
                          backgroundColor: meta.bg,
                          borderColor: meta.color,
                        },
                      ]}
                      onPress={() => setNoteBillType(type)}
                    >
                      <Ionicons
                        name={meta.icon}
                        size={14}
                        color={active ? meta.color : "#bbb"}
                      />
                      <Text
                        style={[
                          styles.typeBtnText,
                          active && { color: meta.color },
                        ]}
                      >
                        {meta.label}
                      </Text>
                    </TouchableOpacity>
                  );
                })}
              </View>

              <Text style={styles.formLabel}>Note</Text>
              <TextInput
                style={[styles.input, styles.textArea]}
                placeholder="Add any note..."
                multiline
                numberOfLines={4}
                value={noteText}
                onChangeText={setNoteText}
              />

              <View style={styles.modalButtons}>
                <TouchableOpacity
                  style={styles.cancelBtn}
                  onPress={() => {
                    setNoteModalVisible(false);
                    setSelectedMember(null);
                    setNoteText("");
                  }}
                >
                  <Text style={styles.cancelBtnText}>Cancel</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  style={[
                    styles.confirmBtn,
                    { backgroundColor: colors.internetColor },
                  ]}
                  onPress={handleAddNote}
                >
                  <Text style={styles.confirmBtnText}>Add Note</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
        </View>
      </Modal>
    </ScrollViewWithDetection>
  );
};

const createStyles = (colors) =>
  StyleSheet.create({
    /* ── Layout ── */
    container: { flex: 1, backgroundColor: colors.background },
    centerWrap: {
      flex: 1,
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: colors.background,
    },
    loadingText: { fontSize: 13, color: colors.textTertiary, marginTop: 10 },

    /* ── Summary Strip ── */
    summaryStrip: {
      flexDirection: "row",
      alignItems: "center",
      backgroundColor: colors.card,
      marginHorizontal: 14,
      marginTop: 14,
      borderRadius: 14,
      padding: 14,
      gap: 10,
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.06,
          shadowRadius: 6,
          shadowOffset: { width: 0, height: 2 },
        },
        android: { elevation: 2 },
      }),
    },
    stripIconWrap: {
      width: 34,
      height: 34,
      borderRadius: 10,
      justifyContent: "center",
      alignItems: "center",
    },
    stripTitle: { fontSize: 16, fontWeight: "700", color: colors.text },
    stripSubtitle: { fontSize: 12, color: colors.textTertiary, marginTop: 2 },
    summaryPanel: {
      backgroundColor: colors.card,
      marginHorizontal: 16,
      marginTop: 16,
      borderRadius: 22,
      padding: 16,
      borderWidth: 1,
      borderColor: colors.borderLight,
      ...Platform.select({
        ios: {
          shadowColor: colors.shadow || "#000",
          shadowOpacity: 0.08,
          shadowRadius: 14,
          shadowOffset: { width: 0, height: 8 },
        },
        android: { elevation: 4 },
      }),
    },
    summaryTopRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
    },
    summaryIconWrap: {
      width: 42,
      height: 42,
      borderRadius: 15,
      backgroundColor: colors.accent,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    summaryCopy: {
      flex: 1,
      minWidth: 0,
    },
    summaryEyebrow: {
      fontSize: 11,
      fontWeight: "800",
      color: colors.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.5,
    },
    summaryTitle: {
      fontSize: 18,
      fontWeight: "900",
      color: colors.text,
      marginTop: 3,
    },
    summaryStatsRow: {
      flexDirection: "row",
      gap: 8,
      marginTop: 14,
    },
    summaryStatCard: {
      flex: 1,
      minWidth: 0,
      borderRadius: 15,
      backgroundColor: colors.background,
      borderWidth: 1,
      borderColor: colors.borderLight,
      paddingHorizontal: 10,
      paddingVertical: 11,
    },
    summaryStatValue: {
      fontSize: 15,
      fontWeight: "900",
      color: colors.text,
      includeFontPadding: false,
    },
    summaryStatLabel: {
      fontSize: 10,
      fontWeight: "700",
      color: colors.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.35,
      marginTop: 5,
      includeFontPadding: false,
    },

    /* ── Sections ── */
    section: { paddingHorizontal: 16, marginTop: 18, paddingBottom: 24 },
    sectionHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      marginBottom: 12,
    },
    sectionTitle: { fontSize: 15, fontWeight: "700", color: colors.text },

    /* ── Empty State ── */
    emptyCard: {
      backgroundColor: colors.card,
      borderRadius: 14,
      padding: 28,
      alignItems: "center",
      ...Platform.select({
        ios: {
          shadowColor: "#000",
          shadowOpacity: 0.05,
          shadowRadius: 4,
          shadowOffset: { width: 0, height: 1 },
        },
        android: { elevation: 1 },
      }),
    },
    emptyIconWrap: {
      width: 56,
      height: 56,
      borderRadius: 28,
      backgroundColor: colors.accentSurface,
      justifyContent: "center",
      alignItems: "center",
      marginBottom: 12,
    },
    emptyTitle: {
      fontSize: 15,
      fontWeight: "700",
      color: colors.text,
      marginBottom: 4,
    },
    emptySubtitle: {
      fontSize: 13,
      color: colors.textTertiary,
      textAlign: "center",
      lineHeight: 18,
    },

    /* ── Member Card ── */
    memberCard: {
      backgroundColor: colors.card,
      borderRadius: 18,
      padding: 16,
      marginBottom: 12,
      borderWidth: 1,
      borderColor: colors.borderLight,
      ...Platform.select({
        ios: {
          shadowColor: colors.shadow || "#000",
          shadowOpacity: 0.06,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 5 },
        },
        android: { elevation: 2 },
      }),
    },
    memberHeader: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "flex-start",
      gap: 10,
      marginBottom: 14,
    },
    memberLeft: {
      flexDirection: "row",
      alignItems: "center",
      flex: 1,
      minWidth: 0,
      gap: 10,
    },
    memberRight: {
      alignItems: "flex-end",
      gap: 4,
      maxWidth: 124,
      flexShrink: 0,
    },
    memberAvatar: {
      width: 38,
      height: 38,
      borderRadius: 19,
      justifyContent: "center",
      alignItems: "center",
      flexShrink: 0,
    },
    avatarText: { fontSize: 14, fontWeight: "700" },
    memberIdentity: {
      flex: 1,
      minWidth: 0,
    },
    memberName: { fontSize: 15, fontWeight: "800", color: colors.text },
    presenceRow: {
      flexDirection: "row",
      alignItems: "center",
      gap: 4,
      marginTop: 2,
    },
    presenceText: { fontSize: 11, color: colors.textTertiary },
    memberTotal: {
      fontSize: 17,
      fontWeight: "900",
      color: colors.accent,
      textAlign: "right",
      width: "100%",
      includeFontPadding: false,
    },
    paidChip: {
      flexDirection: "row",
      alignItems: "center",
      gap: 3,
      backgroundColor: colors.successBg,
      borderRadius: 6,
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    paidChipText: { fontSize: 10, fontWeight: "700", color: colors.success },

    /* ── Charge Rows ── */
    chargesDetails: {
      backgroundColor: colors.cardAlt,
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },
    chargeRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingVertical: 7,
    },
    chargeLeft: { flexDirection: "row", alignItems: "center", gap: 8 },
    chargeIconWrap: {
      width: 24,
      height: 24,
      borderRadius: 7,
      justifyContent: "center",
      alignItems: "center",
    },
    chargeLabel: { fontSize: 13, color: colors.textSecondary },
    chargeValue: { fontSize: 13, fontWeight: "600", color: colors.text },
    chargeTotalRow: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      marginTop: 6,
      paddingTop: 8,
      borderTopWidth: StyleSheet.hairlineWidth,
      borderTopColor: colors.border,
    },
    chargeTotalLabel: { fontSize: 13, fontWeight: "600", color: colors.text },
    chargeTotalValue: { fontSize: 14, fontWeight: "700", color: colors.accent },
    chargeNote: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.infoBg,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      marginTop: 8,
    },
    chargeNoteText: {
      fontSize: 11,
      color: colors.waterColor,
      fontStyle: "italic",
      flex: 1,
    },
    adjustmentNote: {
      flexDirection: "row",
      alignItems: "center",
      gap: 6,
      backgroundColor: colors.accentSurface,
      borderRadius: 8,
      paddingVertical: 6,
      paddingHorizontal: 10,
      marginTop: 8,
    },
    adjustmentNoteText: {
      fontSize: 11,
      color: colors.accent,
      fontWeight: "600",
      flex: 1,
    },

    /* ── Action Buttons ── */
    actionButtons: { flexDirection: "row", gap: 8 },
    actionBtn: {
      flex: 1,
      paddingVertical: 10,
      borderRadius: 10,
      justifyContent: "center",
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
    },
    adjustBtn: { backgroundColor: colors.accent },
    refundBtn: { backgroundColor: colors.electricityColor },
    noteBtn: { backgroundColor: colors.internetColor },
    actionBtnText: { color: "#FFF", fontWeight: "700", fontSize: 13 },

    /* ── Paid Notice ── */
    paidNotice: {
      flexDirection: "row",
      alignItems: "center",
      gap: 8,
      backgroundColor: colors.successBg,
      paddingVertical: 10,
      paddingHorizontal: 12,
      borderRadius: 10,
    },
    paidNoticeText: { color: colors.success, fontSize: 12, fontWeight: "600" },

    /* ── Modals ── */
    modalOverlay: {
      flex: 1,
      backgroundColor: "rgba(0,0,0,0.45)",
      justifyContent: "center",
      alignItems: "center",
    },
    modalContent: {
      backgroundColor: colors.card,
      borderRadius: 18,
      padding: 22,
      width: "90%",
      maxHeight: "85%",
    },
    modalHeader: {
      flexDirection: "row",
      alignItems: "center",
      gap: 12,
      marginBottom: 16,
    },
    modalIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 12,
      justifyContent: "center",
      alignItems: "center",
    },
    modalTitle: { fontSize: 17, fontWeight: "700", color: colors.text },
    modalSubtitle: { fontSize: 13, color: colors.textTertiary, marginTop: 1 },
    form: { maxHeight: 500 },
    adjustmentInfoBox: {
      borderWidth: 1,
      borderColor: colors.borderLight,
      borderRadius: 12,
      backgroundColor: colors.cardAlt,
      padding: 12,
      marginBottom: 6,
    },
    adjustmentInfoLabel: {
      fontSize: 11,
      fontWeight: "700",
      color: colors.textTertiary,
      textTransform: "uppercase",
      letterSpacing: 0.35,
    },
    adjustmentInfoAmount: {
      fontSize: 18,
      fontWeight: "900",
      color: colors.accent,
      marginTop: 4,
    },
    formLabel: {
      fontSize: 12,
      fontWeight: "600",
      color: colors.textSecondary,
      marginTop: 12,
      marginBottom: 8,
    },
    typeButtons: {
      flexDirection: "row",
      flexWrap: "wrap",
      gap: 8,
      marginBottom: 12,
    },
    typeBtn: {
      flex: 1,
      minWidth: "22%",
      borderWidth: 1,
      borderColor: colors.divider,
      borderRadius: 10,
      paddingVertical: 10,
      justifyContent: "center",
      alignItems: "center",
      gap: 4,
    },
    typeBtnText: {
      fontSize: 11,
      color: colors.textTertiary,
      fontWeight: "600",
    },
    input: {
      borderWidth: 1,
      borderColor: colors.border,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 12,
      fontSize: 14,
      color: colors.text,
      backgroundColor: colors.cardAlt,
      marginBottom: 10,
    },
    textArea: { textAlignVertical: "top", minHeight: 72 },
    modalButtons: {
      flexDirection: "row",
      gap: 12,
      marginTop: 18,
    },
    cancelBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: colors.background,
      justifyContent: "center",
      alignItems: "center",
    },
    cancelBtnText: {
      color: colors.textSecondary,
      fontWeight: "600",
      fontSize: 14,
    },
    confirmBtn: {
      flex: 1,
      paddingVertical: 12,
      borderRadius: 10,
      backgroundColor: colors.accent,
      justifyContent: "center",
      alignItems: "center",
    },
    confirmBtnText: { color: "#FFF", fontWeight: "700", fontSize: 14 },
  });

export default AdminAdjustmentsScreen;
