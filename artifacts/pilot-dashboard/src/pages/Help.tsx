import { Card, PageHead } from "@/components/Layout";
import { useI18n, type Key as TKey } from "@/lib/i18n";
import {
  KeyRound,
  Settings as SettingsIcon,
  LogIn,
  UserPlus,
  Upload,
  ListChecks,
  BadgeCheck,
  FileDown,
  Megaphone,
  Smartphone,
  Eye,
  ShieldOff,
  LifeBuoy,
  FileBarChart,
  Wand2,
  Printer,
  Save,
  PlaneTakeoff,
  Users as UsersIcon,
  Trophy,
  CalendarDays,
  CalendarClock,
  ShieldAlert,
  Map as MapIcon,
  AlertTriangle,
  Bell,
  Archive,
  Database,
  RefreshCw,
  History,
  Building2,
  Link2,
  QrCode,
  Network,
  Timer,
  RotateCcw,
  Layers,
} from "lucide-react";

type Step = { titleKey: TKey; bodyKey: TKey; Icon: typeof KeyRound };

const FIRST_TIME: Step[] = [
  { titleKey: "help_first_1_t", bodyKey: "help_first_1_b", Icon: KeyRound },
  { titleKey: "help_first_2_t", bodyKey: "help_first_2_b", Icon: SettingsIcon },
  { titleKey: "help_first_3_t", bodyKey: "help_first_3_b", Icon: LogIn },
  { titleKey: "help_first_4_t", bodyKey: "help_first_4_b", Icon: UserPlus },
  { titleKey: "help_first_5_t", bodyKey: "help_first_5_b", Icon: Upload },
];

const DAILY: Step[] = [
  { titleKey: "help_daily_1_t", bodyKey: "help_daily_1_b", Icon: ListChecks },
  { titleKey: "help_daily_2_t", bodyKey: "help_daily_2_b", Icon: BadgeCheck },
  { titleKey: "help_daily_3_t", bodyKey: "help_daily_3_b", Icon: FileDown },
  { titleKey: "help_daily_4_t", bodyKey: "help_daily_4_b", Icon: Megaphone },
];

const PILOTS: Step[] = [
  { titleKey: "help_pilots_1_t", bodyKey: "help_pilots_1_b", Icon: Smartphone },
  { titleKey: "help_pilots_2_t", bodyKey: "help_pilots_2_b", Icon: Eye },
  { titleKey: "help_pilots_3_t", bodyKey: "help_pilots_3_b", Icon: ShieldOff },
];

const MONTHLY: Step[] = [
  { titleKey: "help_mr_1_t", bodyKey: "help_mr_1_b", Icon: FileBarChart },
  { titleKey: "help_mr_2_t", bodyKey: "help_mr_2_b", Icon: Wand2 },
  { titleKey: "help_mr_3_t", bodyKey: "help_mr_3_b", Icon: BadgeCheck },
  { titleKey: "help_mr_4_t", bodyKey: "help_mr_4_b", Icon: Save },
  { titleKey: "help_mr_5_t", bodyKey: "help_mr_5_b", Icon: Printer },
];

const SORTIES: Step[] = [
  { titleKey: "help_sortie_1_t", bodyKey: "help_sortie_1_b", Icon: PlaneTakeoff },
  { titleKey: "help_sortie_2_t", bodyKey: "help_sortie_2_b", Icon: ListChecks },
  { titleKey: "help_sortie_3_t", bodyKey: "help_sortie_3_b", Icon: UserPlus },
];

const ROSTER: Step[] = [
  { titleKey: "help_roster_1_t", bodyKey: "help_roster_1_b", Icon: UsersIcon },
  { titleKey: "help_roster_2_t", bodyKey: "help_roster_2_b", Icon: Eye },
  { titleKey: "help_roster_3_t", bodyKey: "help_roster_3_b", Icon: Trophy },
];

const CURRENCY: Step[] = [
  { titleKey: "help_curr_1_t", bodyKey: "help_curr_1_b", Icon: BadgeCheck },
  { titleKey: "help_curr_2_t", bodyKey: "help_curr_2_b", Icon: AlertTriangle },
  { titleKey: "help_curr_3_t", bodyKey: "help_curr_3_b", Icon: Bell },
];

const SCHEDULE: Step[] = [
  { titleKey: "help_sched_1_t", bodyKey: "help_sched_1_b", Icon: CalendarDays },
  { titleKey: "help_sched_2_t", bodyKey: "help_sched_2_b", Icon: CalendarClock },
  { titleKey: "help_sched_3_t", bodyKey: "help_sched_3_b", Icon: ShieldAlert },
  { titleKey: "help_sched_4_t", bodyKey: "help_sched_4_b", Icon: UsersIcon },
];

const REFERENCE: Step[] = [
  { titleKey: "help_ref_1_t", bodyKey: "help_ref_1_b", Icon: Megaphone },
  { titleKey: "help_ref_2_t", bodyKey: "help_ref_2_b", Icon: MapIcon },
  { titleKey: "help_ref_3_t", bodyKey: "help_ref_3_b", Icon: Building2 },
];

const REPORTS: Step[] = [
  { titleKey: "help_rep_1_t", bodyKey: "help_rep_1_b", Icon: FileDown },
  { titleKey: "help_rep_2_t", bodyKey: "help_rep_2_b", Icon: FileBarChart },
  { titleKey: "help_rep_3_t", bodyKey: "help_rep_3_b", Icon: Archive },
];

const ADMIN: Step[] = [
  { titleKey: "help_adm_1_t", bodyKey: "help_adm_1_b", Icon: UsersIcon },
  { titleKey: "help_adm_2_t", bodyKey: "help_adm_2_b", Icon: History },
  { titleKey: "help_adm_3_t", bodyKey: "help_adm_3_b", Icon: ShieldOff },
];

const PAIRING: Step[] = [
  { titleKey: "help_pair_1_t", bodyKey: "help_pair_1_b", Icon: Link2 },
  { titleKey: "help_pair_2_t", bodyKey: "help_pair_2_b", Icon: QrCode },
  { titleKey: "help_pair_3_t", bodyKey: "help_pair_3_b", Icon: BadgeCheck },
  { titleKey: "help_pair_4_t", bodyKey: "help_pair_4_b", Icon: Network },
  { titleKey: "help_pair_5_t", bodyKey: "help_pair_5_b", Icon: Timer },
  { titleKey: "help_pair_6_t", bodyKey: "help_pair_6_b", Icon: RotateCcw },
  { titleKey: "help_pair_7_t", bodyKey: "help_pair_7_b", Icon: Layers },
];

const SYSTEM: Step[] = [
  { titleKey: "help_sys_1_t", bodyKey: "help_sys_1_b", Icon: SettingsIcon },
  { titleKey: "help_sys_2_t", bodyKey: "help_sys_2_b", Icon: KeyRound },
  { titleKey: "help_sys_3_t", bodyKey: "help_sys_3_b", Icon: RefreshCw },
  { titleKey: "help_sys_4_t", bodyKey: "help_sys_4_b", Icon: Database },
  { titleKey: "help_sys_5_t", bodyKey: "help_sys_5_b", Icon: Upload },
];

function Section({ title, steps }: { title: string; steps: Step[] }) {
  return (
    <Card className="space-y-3">
      <div className="text-sm font-semibold gold-grad uppercase tracking-wider">{title}</div>
      <div className="space-y-3">
        {steps.map(({ titleKey, bodyKey, Icon }) => (
          <Step key={titleKey} titleKey={titleKey} bodyKey={bodyKey} Icon={Icon} />
        ))}
      </div>
    </Card>
  );
}

function Step({ titleKey, bodyKey, Icon }: Step) {
  const { t } = useI18n();
  return (
    <div className="flex gap-3 items-start">
      <div className="shrink-0 h-9 w-9 rounded-md bg-secondary border border-border flex items-center justify-center">
        <Icon className="h-4 w-4 text-primary" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-semibold">{t(titleKey)}</div>
        <p className="text-xs text-muted-foreground leading-relaxed mt-0.5">{t(bodyKey)}</p>
      </div>
    </div>
  );
}

export default function Help() {
  const { t } = useI18n();
  return (
    <div>
      <PageHead title={t("help_title")} subtitle={t("help_subtitle")} />
      <div className="grid lg:grid-cols-2 gap-4">
        <Section title={t("help_section_first")} steps={FIRST_TIME} />
        <Section title={t("help_section_daily")} steps={DAILY} />
        <Section title={t("help_section_sorties")} steps={SORTIES} />
        <Section title={t("help_section_roster")} steps={ROSTER} />
        <Section title={t("help_section_currency")} steps={CURRENCY} />
        <Section title={t("help_section_schedule")} steps={SCHEDULE} />
        <Section title={t("help_section_reference")} steps={REFERENCE} />
        <Section title={t("help_section_reports")} steps={REPORTS} />
        <Section title={t("help_section_monthly")} steps={MONTHLY} />
        <Section title={t("help_section_admin")} steps={ADMIN} />
        <Section title={t("help_section_pairing")} steps={PAIRING} />
        <Section title={t("help_section_system")} steps={SYSTEM} />
        <Section title={t("help_section_pilots")} steps={PILOTS} />
        <Card className="space-y-3">
          <div className="text-sm font-semibold gold-grad uppercase tracking-wider">{t("help_section_support")}</div>
          <div className="flex gap-3 items-start">
            <div className="shrink-0 h-9 w-9 rounded-md bg-secondary border border-border flex items-center justify-center">
              <LifeBuoy className="h-4 w-4 text-primary" />
            </div>
            <div className="flex-1 min-w-0 space-y-2">
              <div className="text-sm font-semibold">{t("help_support_t")}</div>
              <p className="text-xs text-muted-foreground leading-relaxed">{t("help_support_b")}</p>
              <div className="text-xs space-y-0.5 pt-1">
                <div><span className="text-muted-foreground">{t("creditsDeveloper")}: </span><span className="font-semibold">Capt. ABEDALQADER GHUNMAT</span></div>
                <div><span className="text-muted-foreground">{t("creditsPhone")}: </span><button type="button" onClick={() => window.open("tel:+9620775008345", "_blank", "noopener")} className="text-primary hover:underline">0775008345</button></div>
                <div><span className="text-muted-foreground">{t("creditsEmail")}: </span><button type="button" onClick={() => window.open("mailto:ghneimatabed1@icloud.com", "_blank", "noopener")} className="text-primary hover:underline">ghneimatabed1@icloud.com</button></div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
