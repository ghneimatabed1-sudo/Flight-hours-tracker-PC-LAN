import { Feather } from "@expo/vector-icons";
import * as Haptics from "expo-haptics";
import React, { useEffect, useMemo, useState } from "react";
import {
  Platform,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Circle, G } from "react-native-svg";

import { CurrencyTile } from "@/components/CurrencyTile";
import { useColors } from "@/hooks/useColors";
import {
  computeCurrencies,
  computePeriodicSummary,
  computeTotals,
  formatHours,
  type PeriodicScope,
} from "@/lib/calculations";
import { useAppData } from "@/lib/data";
import { useI18n } from "@/lib/i18n";

function formatSyncTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  // DD-MM HH:mm — matches the squadron-wide DD-MM-YYYY family.
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getDate())}-${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function timeOfDayKey(hour: number): "home_greet_morning" | "home_greet_afternoon" | "home_greet_evening" {
  if (hour < 12) return "home_greet_morning";
  if (hour < 18) return "home_greet_afternoon";
  return "home_greet_evening";
}

export default function HomeScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const { t, isRTL } = useI18n();
  const { snapshot, refresh, refreshing, remoteEnabled } = useAppData();

  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const totals = useMemo(
    () => (snapshot ? computeTotals(snapshot.profile, snapshot.sorties) : null),
    [snapshot]
  );

  // Periodic Summary state — H1 / H2 / Annual toggle + year picker.
  // Mirrors the dashboard's PdfExports.tsx page so the pilot can pull up
  // the same numbers his squadron commander signs on the paper logbook.
  const currentYear = now.getFullYear();
  const [periodicYear, setPeriodicYear] = useState<number>(currentYear);
  const [periodicScope, setPeriodicScope] = useState<PeriodicScope>(
    // Default scope: H1 if we're in Jan-Jun, else H2.
    now.getMonth() <= 5 ? "H1" : "H2"
  );
  const periodic = useMemo(
    () => snapshot ? computePeriodicSummary(snapshot.profile, snapshot.sorties, periodicYear, periodicScope) : null,
    [snapshot, periodicYear, periodicScope]
  );

  const currencyStrip = useMemo(() => {
    if (!snapshot) return [];
    return computeCurrencies(snapshot.profile).filter((c) => c.key !== "sim");
  }, [snapshot]);

  if (!snapshot || !totals) return null;

  const profile = snapshot.profile;

  const onRefresh = () => {
    if (Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
    void refresh();
  };

  const topPad = (Platform.OS === "web" ? 67 : insets.top) + 16;

  const greetKey = timeOfDayKey(now.getHours());
  const greeting = t(greetKey);
  // DD-MM-YYYY squadron standard. Month label = MM-YYYY.
  const pad = (n: number) => String(n).padStart(2, "0");
  const monthLabel = `${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  const todayDate = `${pad(now.getDate())}-${pad(now.getMonth() + 1)}-${now.getFullYear()}`;
  const localTime = now.toLocaleTimeString(isRTL ? "ar-JO" : "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const align = isRTL ? "right" : "left";
  const rowDir = isRTL ? "row-reverse" : "row";

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.background }}
      contentContainerStyle={[styles.content, { paddingTop: topPad }]}
      refreshControl={
        <RefreshControl
          refreshing={refreshing}
          onRefresh={onRefresh}
          tintColor={colors.primary}
        />
      }
    >
      {/* ── Mission strip ───────────────────────── */}
      <View style={[styles.strip, { borderColor: colors.border, flexDirection: rowDir }]}>
        <View style={[styles.stripDot, { backgroundColor: colors.success }]} />
        <Text style={[styles.stripStencil, { color: colors.mutedForeground }]}>{todayDate}</Text>
        <Text style={[styles.stripDivider, { color: colors.border }]}>│</Text>
        <Text style={[styles.stripStencil, { color: colors.mutedForeground }]}>{t("home_local").toUpperCase()}</Text>
        <Text style={[styles.stripValue, { color: colors.foreground }]}>{localTime}</Text>
        <View style={{ flex: 1 }} />
        <Feather
          name={remoteEnabled ? "wifi" : "wifi-off"}
          size={12}
          color={remoteEnabled ? colors.success : colors.mutedForeground}
        />
      </View>

      {/* ── Greeting ───────────────────────────── */}
      <View>
        <Text style={[styles.greeting, { color: colors.mutedForeground, textAlign: align }]}>
          {greeting}
        </Text>
        <Text style={[styles.name, { color: colors.foreground, textAlign: align }]}>
          {profile.rank} {isRTL && profile.arabicName ? profile.arabicName : profile.name}
        </Text>
        {profile.flightName ? (
          <Text style={[styles.unit, { color: colors.primary, textAlign: align, fontFamily: "monospace" }]}>
            "{profile.flightName}"
          </Text>
        ) : null}
        <Text style={[styles.unit, { color: colors.mutedForeground, textAlign: align }]}>
          {profile.squadron || profile.unit}
        </Text>
      </View>

      {/* ── Currency strip ─────────────────────── */}
      {currencyStrip.length > 0 ? (
        <View style={[styles.currencyStrip, { flexDirection: rowDir }]}>
          {currencyStrip.map((item) => (
            <CurrencyTile key={item.key} item={item} />
          ))}
        </View>
      ) : null}

      {/* ── Hero card ──────────────────────────── */}
      <View
        style={[
          styles.hero,
          { backgroundColor: colors.card, borderColor: colors.primary + "55" },
        ]}
      >
        <View style={[styles.tickTL, { borderColor: colors.primary }]} />
        <View style={[styles.tickTR, { borderColor: colors.primary }]} />
        <View style={[styles.tickBL, { borderColor: colors.primary }]} />
        <View style={[styles.tickBR, { borderColor: colors.primary }]} />

        <Text style={[styles.heroLabel, { color: colors.mutedForeground, textAlign: align }]}>
          {`// ${monthLabel} · ${t("home_total_hours")}`}
        </Text>

        <View style={[styles.heroRow, { flexDirection: rowDir }]}>
          <Text style={[styles.heroValue, { color: colors.primary }]}>
            {formatHours(totals.grandTotal)}
          </Text>
          <Text style={[styles.heroUnit, { color: colors.mutedForeground }]}>{t("home_hrs").toUpperCase()}</Text>
        </View>

        <View style={[styles.heroDivider, { backgroundColor: colors.border }]} />

        <View style={[styles.heroChips, { flexDirection: rowDir }]}>
          <HeroChip label={t("home_day").toUpperCase()} value={formatHours(totals.totalDay)} />
          <HeroChip label={t("home_night").toUpperCase()} value={formatHours(totals.totalNight)} />
          <HeroChip label={t("home_nvg").toUpperCase()} value={formatHours(totals.totalNvg)} accent={colors.primary} />
        </View>
      </View>

      {/* ── Career composition (3 rings + overlay chips) ──── */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.cardHeadRow, { flexDirection: rowDir }]}>
          <Text style={[styles.cardEyebrow, { color: colors.mutedForeground }]}>
            {`// ${t("home_career_title").toUpperCase()}`}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>
            {`${totals.totalSorties} ${t("home_col_sorties")}`}
          </Text>
        </View>

        <View style={[styles.ringsRow, { flexDirection: rowDir }]}>
          <RingStat
            label={t("home_day").toUpperCase()}
            value={totals.totalDay}
            total={totals.grandTotal}
            color={colors.primary}
            track={colors.border}
            fg={colors.foreground}
            muted={colors.mutedForeground}
          />
          <RingStat
            label={t("home_night").toUpperCase()}
            value={totals.totalNight}
            total={totals.grandTotal}
            color="#7C9CFF"
            track={colors.border}
            fg={colors.foreground}
            muted={colors.mutedForeground}
          />
          <RingStat
            label={t("home_nvg").toUpperCase()}
            value={totals.totalNvg}
            total={totals.grandTotal}
            color="#4ADE80"
            track={colors.border}
            fg={colors.foreground}
            muted={colors.mutedForeground}
          />
        </View>

        <View style={[styles.grandBar, { borderColor: colors.border }]}>
          <Text style={[styles.grandLabel, { color: colors.mutedForeground }]}>
            {t("home_total_hours").toUpperCase()}
          </Text>
          <Text style={[styles.grandValue, { color: colors.primary }]}>
            {`${formatHours(totals.grandTotal)} ${t("home_hrs").toUpperCase()}`}
          </Text>
        </View>

        <Text style={[styles.overlayCaption, { color: colors.mutedForeground, textAlign: align }]}>
          {t("home_overlay_caption")}
        </Text>
        <View style={[styles.overlayRow, { flexDirection: rowDir }]}>
          <OverlayPill label={t("home_captain").toUpperCase()} value={formatHours(totals.totalCaptain)} />
          <OverlayPill label={t("home_second_pilot").toUpperCase()} value={formatHours(totals.totalSecondPilot)} />
          <OverlayPill label={t("home_instrument").toUpperCase()} value={formatHours(profile.openingInstrument ?? 0)} />
          <OverlayPill label={t("home_sim").toUpperCase()} value={formatHours(totals.totalSim)} />
        </View>
      </View>

      {/* ── Year breakdown (H1 vs H2 visual bars) ──── */}
      <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
        <View style={[styles.cardHeadRow, { flexDirection: rowDir }]}>
          <Text style={[styles.cardEyebrow, { color: colors.mutedForeground }]}>
            {`// ${new Date().getFullYear()} · ${t("home_breakdown_title").toUpperCase()}`}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.cardMeta, { color: colors.primary, fontFamily: "Inter_700Bold" }]}>
            {`${formatHours(totals.yearHours)} ${t("home_hrs").toUpperCase()}`}
          </Text>
        </View>

        <HalfYearBar
          title={`${t("home_h1")} · ${t("home_h1_hint")}`}
          total={totals.h1.total}
          day={totals.h1.day}
          night={totals.h1.night}
          nvg={totals.h1.nvg}
          sorties={totals.h1.sorties}
          maxValue={Math.max(totals.h1.total, totals.h2.total, 1)}
          rowDir={rowDir}
          align={align}
        />
        <HalfYearBar
          title={`${t("home_h2")} · ${t("home_h2_hint")}`}
          total={totals.h2.total}
          day={totals.h2.day}
          night={totals.h2.night}
          nvg={totals.h2.nvg}
          sorties={totals.h2.sorties}
          maxValue={Math.max(totals.h1.total, totals.h2.total, 1)}
          rowDir={rowDir}
          align={align}
        />

        <View style={[styles.legendRow, { flexDirection: rowDir }]}>
          <LegendDot color={colors.primary} label={t("home_day").toUpperCase()} />
          <LegendDot color="#7C9CFF" label={t("home_night").toUpperCase()} />
          <LegendDot color="#4ADE80" label={t("home_nvg").toUpperCase()} />
        </View>

        <View style={[styles.monthChip, { borderColor: colors.border, flexDirection: rowDir }]}>
          <Feather name="calendar" size={12} color={colors.mutedForeground} />
          <Text style={[styles.monthChipLabel, { color: colors.mutedForeground }]}>
            {t("home_month_hours").toUpperCase()}
          </Text>
          <View style={{ flex: 1 }} />
          <Text style={[styles.monthChipValue, { color: colors.foreground }]}>
            {`${formatHours(totals.monthTotal)} · ${totals.sortiesThisMonth} ${t("home_sortie_count")}`}
          </Text>
        </View>
      </View>

      {/* ── Periodic Summary (paper-logbook H1 / H2 / Annual) ─── */}
      {periodic && (
        <View style={[styles.card, { backgroundColor: colors.card, borderColor: colors.border }]}>
          <View style={[styles.cardHeadRow, { flexDirection: rowDir }]}>
            <Text style={[styles.cardEyebrow, { color: colors.mutedForeground }]}>
              {`// ${t("home_periodic_title").toUpperCase()}`}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>
              {t("home_periodic_hint")}
            </Text>
          </View>

          {/* Year picker — past 4 years */}
          <View style={[styles.periodicRow, { flexDirection: rowDir }]}>
            {[0, 1, 2, 3].map((d) => {
              const y = currentYear - d;
              const active = y === periodicYear;
              return (
                <Pressable
                  key={y}
                  onPress={() => {
                    if (Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
                    setPeriodicYear(y);
                  }}
                  style={[
                    styles.periodicChip,
                    {
                      backgroundColor: active ? colors.primary + "22" : "transparent",
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.periodicChipLabel, { color: active ? colors.primary : colors.foreground }]}>
                    {y}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Scope picker — H1 / H2 / Annual */}
          <View style={[styles.periodicRow, { flexDirection: rowDir }]}>
            {(["H1", "H2", "FULL"] as const).map((s) => {
              const active = s === periodicScope;
              const label = s === "H1" ? t("home_periodic_h1") : s === "H2" ? t("home_periodic_h2") : t("home_periodic_annual");
              return (
                <Pressable
                  key={s}
                  onPress={() => {
                    if (Platform.OS !== "web") Haptics.selectionAsync().catch(() => {});
                    setPeriodicScope(s);
                  }}
                  style={[
                    styles.periodicChip,
                    {
                      flex: 1,
                      backgroundColor: active ? colors.primary + "22" : "transparent",
                      borderColor: active ? colors.primary : colors.border,
                    },
                  ]}
                >
                  <Text style={[styles.periodicChipLabel, { color: active ? colors.primary : colors.foreground }]}>
                    {label}
                  </Text>
                </Pressable>
              );
            })}
          </View>

          {/* Period banner */}
          <View style={[styles.periodicPeriod, { borderColor: colors.border, flexDirection: rowDir }]}>
            <Feather name="calendar" size={12} color={colors.mutedForeground} />
            <Text style={[styles.periodicPeriodLabel, { color: colors.mutedForeground }]}>
              {t("home_periodic_period").toUpperCase()}
            </Text>
            <View style={{ flex: 1 }} />
            <Text style={[styles.periodicPeriodValue, { color: colors.foreground }]}>
              {`${periodic.startISO} → ${periodic.endISO}`}
            </Text>
          </View>

          {/* Six-line breakdown */}
          {periodic.sorties === 0 ? (
            <Text style={[styles.periodicEmpty, { color: colors.mutedForeground, textAlign: align }]}>
              {t("home_periodic_no_sorties")}
            </Text>
          ) : (
            <View style={{ gap: 6 }}>
              <PeriodicRow lbl={t("home_day").toUpperCase()} val={formatHours(periodic.day)} colors={colors} rowDir={rowDir} />
              <PeriodicRow lbl={t("home_night").toUpperCase()} val={formatHours(periodic.night)} colors={colors} rowDir={rowDir} />
              <PeriodicRow lbl={t("home_nvg").toUpperCase()} val={formatHours(periodic.nvg)} colors={colors} rowDir={rowDir} />
              <PeriodicRow lbl={t("home_sim").toUpperCase()} val={formatHours(periodic.sim)} colors={colors} rowDir={rowDir} />
              <PeriodicRow lbl={t("home_captain").toUpperCase()} val={formatHours(periodic.captain)} colors={colors} rowDir={rowDir} />
              <PeriodicRow lbl={t("home_second_pilot").toUpperCase()} val={formatHours(periodic.secondPilot)} colors={colors} rowDir={rowDir} />
              <View style={[styles.periodicTotalRow, { borderColor: colors.border, flexDirection: rowDir }]}>
                <Text style={[styles.periodicTotalLbl, { color: colors.mutedForeground }]}>
                  {t("home_periodic_total6").toUpperCase()}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={[styles.periodicTotalVal, { color: colors.foreground }]}>
                  {formatHours(periodic.total)}
                </Text>
              </View>
              <View style={[styles.periodicTotalRow, { flexDirection: rowDir }]}>
                <Text style={[styles.periodicTotalLbl, { color: colors.primary }]}>
                  {t("home_periodic_grand").toUpperCase()}
                </Text>
                <View style={{ flex: 1 }} />
                <Text style={[styles.periodicTotalVal, { color: colors.primary }]}>
                  {`${formatHours(periodic.grandTotal)} · ${periodic.sorties} ${t("home_sortie_count")}`}
                </Text>
              </View>
            </View>
          )}
        </View>
      )}

      {/* ── Sync card ─────────────────────────── */}
      <View
        style={[
          styles.syncRow,
          {
            backgroundColor: colors.card,
            borderColor: colors.border,
            flexDirection: rowDir,
          },
        ]}
      >
        <View style={[styles.syncLeft, { flexDirection: rowDir }]}>
          <View
            style={[
              styles.syncIconWrap,
              { backgroundColor: (remoteEnabled ? colors.success : colors.mutedForeground) + "1f" },
            ]}
          >
            <Feather
              name={remoteEnabled ? "cloud" : "cloud-off"}
              size={16}
              color={remoteEnabled ? colors.success : colors.mutedForeground}
            />
          </View>
          <View>
            <Text style={[styles.syncLabel, { color: colors.foreground }]}>
              {remoteEnabled ? t("home_last_sync") : t("home_offline")}
            </Text>
            <Text style={[styles.syncValue, { color: colors.mutedForeground }]}>
              {formatSyncTime(snapshot.fetchedAt)}
            </Text>
          </View>
        </View>
        <Pressable
          onPress={onRefresh}
          disabled={refreshing}
          style={({ pressed }) => [
            styles.refreshBtn,
            {
              backgroundColor: colors.primary,
              opacity: pressed || refreshing ? 0.7 : 1,
            },
          ]}
        >
          <Feather name="refresh-cw" size={14} color={colors.primaryForeground} />
          <Text style={[styles.refreshText, { color: colors.primaryForeground }]}>
            {t("home_refresh")}
          </Text>
        </Pressable>
      </View>
    </ScrollView>
  );
}

function HeroChip({ label, value, accent }: { label: string; value: string; accent?: string }) {
  const colors = useColors();
  return (
    <View style={styles.chip}>
      <Text style={[styles.chipLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.chipValue, { color: accent ?? colors.foreground }]}>{value}</Text>
    </View>
  );
}

/**
 * Circular ring stat used in the career composition card. Renders a thin
 * track with a thicker accent arc representing `value / total`. The center
 * of the ring shows the absolute hours; the percentage of career total
 * sits below the label so the pilot reads:
 *
 *   12.4
 *    DAY
 *    62%
 *
 * Designed to live in a 3-up row alongside Night and NVG so the pilot
 * sees the full flying mix at a glance without a spreadsheet.
 */
function RingStat({
  label,
  value,
  total,
  color,
  track,
  fg,
  muted,
}: {
  label: string;
  value: number;
  total: number;
  color: string;
  track: string;
  fg: string;
  muted: string;
}) {
  const size = 92;
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circ = 2 * Math.PI * radius;
  const pct = total > 0 ? Math.min(1, value / total) : 0;
  const dash = circ * pct;
  const pctLabel = `${Math.round(pct * 100)}%`;

  return (
    <View style={styles.ringWrap}>
      <View style={{ width: size, height: size }}>
        <Svg width={size} height={size}>
          <G rotation={-90} originX={size / 2} originY={size / 2}>
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={track}
              strokeOpacity={0.6}
              strokeWidth={stroke}
              fill="none"
            />
            <Circle
              cx={size / 2}
              cy={size / 2}
              r={radius}
              stroke={color}
              strokeWidth={stroke}
              strokeLinecap="round"
              strokeDasharray={`${dash} ${circ - dash}`}
              fill="none"
            />
          </G>
        </Svg>
        <View style={styles.ringCenter}>
          <Text style={[styles.ringValue, { color: fg }]}>{formatHours(value)}</Text>
        </View>
      </View>
      <Text style={[styles.ringLabel, { color: muted }]}>{label}</Text>
      <Text style={[styles.ringPct, { color }]}>{pctLabel}</Text>
    </View>
  );
}

/**
 * Pill-shaped overlay stat (Captain / Second Pilot / Instrument / Sim).
 * Sits in a 4-up wrap row beneath the rings. Visually distinct from the
 * grand-total bar so pilots understand these are *labels on the same
 * flight time*, not extra hours that add to the total — see the
 * `Time vs Overlay` rule in `.local/memory/initial-hours.md`.
 */
function OverlayPill({ label, value }: { label: string; value: string }) {
  const colors = useColors();
  return (
    <View style={[styles.pill, { backgroundColor: colors.background, borderColor: colors.border }]}>
      <Text style={[styles.pillLabel, { color: colors.mutedForeground }]}>{label}</Text>
      <Text style={[styles.pillValue, { color: colors.foreground }]}>{value}</Text>
    </View>
  );
}

/**
 * Single half-year row: a horizontal stacked bar split into Day/Night/NVG
 * segments, sized proportional to the larger of H1/H2 so both halves
 * share a common scale. The right side carries hours + sortie count so
 * the row reads top-to-bottom as a tiny chart card.
 */
function HalfYearBar({
  title,
  total,
  day,
  night,
  nvg,
  sorties,
  maxValue,
  rowDir,
  align,
}: {
  title: string;
  total: number;
  day: number;
  night: number;
  nvg: number;
  sorties: number;
  maxValue: number;
  rowDir: "row" | "row-reverse";
  align: "left" | "right";
}) {
  const colors = useColors();
  const widthPct = Math.max(0.04, total / maxValue) * 100;
  const safe = total > 0 ? total : 1;
  const dayPct = total > 0 ? (day / safe) * 100 : 100;
  const nightPct = total > 0 ? (night / safe) * 100 : 0;
  const nvgPct = total > 0 ? (nvg / safe) * 100 : 0;
  const empty = total === 0;

  return (
    <View style={styles.halfRow}>
      <View style={[styles.halfHeader, { flexDirection: rowDir }]}>
        <Text style={[styles.halfTitle, { color: colors.foreground, textAlign: align }]}>{title}</Text>
        <View style={{ flex: 1 }} />
        <Text style={[styles.halfMeta, { color: colors.mutedForeground }]}>
          {`${formatHours(total)} · ${sorties}`}
        </Text>
      </View>
      <View style={[styles.barTrack, { backgroundColor: colors.border }]}>
        <View
          style={{
            width: `${widthPct}%`,
            height: "100%",
            flexDirection: "row",
            opacity: empty ? 0.25 : 1,
            borderRadius: 6,
            overflow: "hidden",
          }}
        >
          <View style={{ width: `${dayPct}%`, backgroundColor: empty ? colors.mutedForeground : colors.primary }} />
          <View style={{ width: `${nightPct}%`, backgroundColor: "#7C9CFF" }} />
          <View style={{ width: `${nvgPct}%`, backgroundColor: "#4ADE80" }} />
        </View>
      </View>
    </View>
  );
}

function PeriodicRow({
  lbl, val, colors, rowDir,
}: {
  lbl: string;
  val: string;
  colors: ReturnType<typeof useColors>;
  rowDir: "row" | "row-reverse";
}) {
  return (
    <View style={[styles.periodicLine, { flexDirection: rowDir }]}>
      <Text style={[styles.periodicLineLbl, { color: colors.mutedForeground }]}>{lbl}</Text>
      <View style={{ flex: 1 }} />
      <Text style={[styles.periodicLineVal, { color: colors.foreground }]}>{val}</Text>
    </View>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  const colors = useColors();
  return (
    <View style={styles.legendItem}>
      <View style={[styles.legendSwatch, { backgroundColor: color }]} />
      <Text style={[styles.legendLabel, { color: colors.mutedForeground }]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    padding: 18,
    paddingBottom: 120,
    gap: 16,
  },

  // mission strip
  strip: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  stripDot: { width: 7, height: 7, borderRadius: 999 },
  stripStencil: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.6,
  },
  stripValue: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.4,
  },
  stripDivider: { fontSize: 12 },

  // greeting
  greeting: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.6,
    textTransform: "uppercase",
  },
  name: {
    fontSize: 28,
    fontFamily: "Inter_700Bold",
    marginTop: 4,
    letterSpacing: -0.4,
  },
  unit: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    marginTop: 2,
    letterSpacing: 0.4,
  },

  // hero
  hero: {
    padding: 22,
    borderRadius: 18,
    borderWidth: 1,
    overflow: "hidden",
    position: "relative",
    gap: 14,
  },
  heroLabel: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.8,
  },
  heroRow: {
    alignItems: "baseline",
    gap: 8,
  },
  heroValue: {
    fontSize: 64,
    fontFamily: "Inter_700Bold",
    letterSpacing: -2,
    fontVariant: ["tabular-nums"],
    lineHeight: 68,
  },
  heroUnit: {
    fontSize: 13,
    fontFamily: "Inter_700Bold",
    letterSpacing: 2,
  },
  heroDivider: {
    height: StyleSheet.hairlineWidth,
    opacity: 0.6,
  },
  heroChips: {
    justifyContent: "space-between",
    gap: 12,
  },
  chip: { flex: 1, gap: 4 },
  chipLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.4,
  },
  chipValue: {
    fontSize: 18,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  tickTL: { position: "absolute", top: 8, left: 8, width: 12, height: 12, borderTopWidth: 1, borderLeftWidth: 1, opacity: 0.7 },
  tickTR: { position: "absolute", top: 8, right: 8, width: 12, height: 12, borderTopWidth: 1, borderRightWidth: 1, opacity: 0.7 },
  tickBL: { position: "absolute", bottom: 8, left: 8, width: 12, height: 12, borderBottomWidth: 1, borderLeftWidth: 1, opacity: 0.7 },
  tickBR: { position: "absolute", bottom: 8, right: 8, width: 12, height: 12, borderBottomWidth: 1, borderRightWidth: 1, opacity: 0.7 },

  // currency strip
  currencyStrip: {
    gap: 6,
    alignItems: "stretch",
  },

  // ── Career composition + year breakdown card ────────────────────
  card: {
    borderRadius: 18,
    borderWidth: StyleSheet.hairlineWidth,
    padding: 18,
    gap: 14,
  },
  cardHeadRow: {
    alignItems: "center",
    gap: 8,
  },
  cardEyebrow: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.8,
    textTransform: "uppercase",
  },
  cardMeta: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
    fontVariant: ["tabular-nums"],
  },

  // rings
  ringsRow: {
    alignItems: "center",
    justifyContent: "space-between",
    gap: 8,
  },
  ringWrap: {
    flex: 1,
    alignItems: "center",
    gap: 6,
  },
  ringCenter: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  ringValue: {
    fontSize: 20,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.5,
    fontVariant: ["tabular-nums"],
  },
  ringLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.6,
  },
  ringPct: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.4,
  },

  // grand total bar
  grandBar: {
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  grandLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.8,
  },
  grandValue: {
    fontSize: 22,
    fontFamily: "Inter_700Bold",
    letterSpacing: -0.6,
    fontVariant: ["tabular-nums"],
  },

  // overlays
  overlayCaption: {
    fontSize: 9,
    fontFamily: "Inter_500Medium",
    letterSpacing: 1.4,
    textTransform: "uppercase",
    opacity: 0.75,
  },
  overlayRow: {
    flexWrap: "wrap",
    gap: 6,
  },
  pill: {
    flexGrow: 1,
    flexBasis: "47%",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "baseline",
    justifyContent: "space-between",
    gap: 8,
  },
  pillLabel: {
    fontSize: 10,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
  },
  pillValue: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },

  // half-year stacked bars
  halfRow: {
    gap: 6,
  },
  halfHeader: {
    alignItems: "baseline",
    gap: 8,
  },
  halfTitle: {
    fontSize: 12,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 0.3,
  },
  halfMeta: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.4,
  },
  barTrack: {
    height: 12,
    borderRadius: 6,
    overflow: "hidden",
  },

  // legend
  legendRow: {
    alignItems: "center",
    gap: 14,
    paddingTop: 4,
  },
  legendItem: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  legendSwatch: {
    width: 8,
    height: 8,
    borderRadius: 2,
  },
  legendLabel: {
    fontSize: 9,
    fontFamily: "Inter_600SemiBold",
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },

  // month chip
  monthChip: {
    alignItems: "center",
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 8,
    marginTop: 4,
  },
  monthChipLabel: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.6,
  },
  monthChipValue: {
    fontSize: 12,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
    letterSpacing: 0.3,
  },

  // sync
  syncRow: {
    marginTop: 4,
    padding: 14,
    borderRadius: 14,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "space-between",
    gap: 12,
  },
  syncIconWrap: {
    width: 32,
    height: 32,
    borderRadius: 8,
    alignItems: "center",
    justifyContent: "center",
  },
  syncLeft: { alignItems: "center", gap: 10, flex: 1 },
  syncLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  syncValue: { fontSize: 11, fontFamily: "Inter_400Regular", marginTop: 2 },
  refreshBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 10,
  },
  refreshText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },

  // ── Periodic Summary card ────────────────────────────────────────
  periodicRow: {
    flexWrap: "wrap",
    gap: 6,
  },
  periodicChip: {
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  periodicChipLabel: {
    fontSize: 11,
    fontFamily: "Inter_700Bold",
    letterSpacing: 0.6,
  },
  periodicPeriod: {
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  periodicPeriodLabel: {
    fontSize: 9,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.4,
  },
  periodicPeriodValue: {
    fontSize: 11,
    fontFamily: "Inter_600SemiBold",
    fontVariant: ["tabular-nums"],
  },
  periodicLine: {
    alignItems: "baseline",
    gap: 6,
  },
  periodicLineLbl: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.4,
  },
  periodicLineVal: {
    fontSize: 14,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  periodicTotalRow: {
    alignItems: "baseline",
    gap: 6,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  periodicTotalLbl: {
    fontSize: 10,
    fontFamily: "Inter_700Bold",
    letterSpacing: 1.4,
  },
  periodicTotalVal: {
    fontSize: 16,
    fontFamily: "Inter_700Bold",
    fontVariant: ["tabular-nums"],
  },
  periodicEmpty: {
    fontSize: 12,
    fontFamily: "Inter_500Medium",
    paddingVertical: 8,
  },
});
