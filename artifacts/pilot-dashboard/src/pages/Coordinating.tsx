import { Card, PageHead } from "@/components/Layout";
import { useI18n } from "@/lib/i18n";

export default function Coordinating() {
  const { t } = useI18n();
  return (
    <div dir="rtl">
      <PageHead title={t("nav_coord")} subtitle="نموذج تنسيق المهام بين الوحدات" />
      <Card className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="رقم النموذج" />
          <Field label="التاريخ" type="date" />
          <Field label="الوحدة الطالبة" />
          <Field label="الوحدة المنفذة" />
          <Field label="نوع المهمة" />
          <Field label="منطقة العمليات" />
          <Field label="ساعة الإقلاع" type="time" />
          <Field label="ساعة الهبوط" type="time" />
        </div>
        <Area label="تفاصيل المهمة" />
        <Area label="ملاحظات السلامة" />
        <div className="grid grid-cols-3 gap-3 pt-2">
          <Field label="ضابط العمليات" />
          <Field label="قائد السرب" />
          <Field label="ضابط السلامة" />
        </div>
        <div className="flex gap-2 pt-2">
          <button className="px-4 py-2 rounded-md bg-primary text-primary-foreground font-medium">حفظ</button>
          <button className="px-4 py-2 rounded-md bg-secondary border border-border">تصدير PDF</button>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, type = "text" }: { label: string; type?: string }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <input type={type} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
    </label>
  );
}
function Area({ label }: { label: string }) {
  return (
    <label className="block">
      <span className="text-xs text-muted-foreground">{label}</span>
      <textarea rows={3} className="w-full mt-1 px-3 py-2 rounded-md bg-input border border-border text-sm" />
    </label>
  );
}
