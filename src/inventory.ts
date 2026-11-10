import { prisma } from './db';
import { notifyTenant } from './push';

/**
 * بعد أي خصم للمخزون: لو صنف نزل لحد الحد الأدنى (minQty) أو تحته
 * بعد ما كان فوقه، ابعت تنبيه للمالك والمدير.
 * (بنبعت وقت "العبور" بس، عشان مايتبعتش تنبيه مع كل عملية بيع.)
 */
export async function notifyLowStock(
  tenantId: string,
  before: Array<{ id: string; qtyBefore: number }>,
) {
  try {
    if (before.length === 0) return;
    const now = await prisma.product.findMany({
      where: { tenantId, id: { in: before.map((b) => b.id) } },
      select: { id: true, name: true, qty: true, minQty: true },
    });

    const crossed = now.filter((p) => {
      const b = before.find((x) => x.id === p.id);
      return b !== undefined && b.qtyBefore > p.minQty && p.qty <= p.minQty;
    });
    if (crossed.length === 0) return;

    const list = crossed
      .slice(0, 3)
      .map((p) => `${p.name} (${p.qty})`)
      .join('، ');
    const more = crossed.length > 3 ? ` و${crossed.length - 3} أصناف تانية` : '';

    await notifyTenant(tenantId, ['OWNER', 'MANAGER'], {
      title: 'تنبيه مخزون ⚠️',
      body: `${list}${more}`,
      data: { type: 'low_stock', productIds: crossed.map((p) => p.id) },
    });
  } catch (err) {
    console.error('low stock notify failed:', err);
  }
}
