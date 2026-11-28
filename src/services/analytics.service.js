import { db } from '../mock/db.js';
import { delay, USE_MOCK_API } from './apiClient.js';
import { orderService } from './order.service.js';
import { sellerProductService } from './sellerProduct.service.js';
import { enquiryService } from './enquiry.service.js';

export const analyticsService = {
  async getAnalyticsData(params = '30d') {
    const startDate = typeof params === 'object' ? params.startDate : null;
    const endDate = typeof params === 'object' ? params.endDate : null;

    let orders = [];
    let products = [];
    let enquiries = [];
    let mockBase = {};

    if (!USE_MOCK_API) {
      const [ordRes, prodRes, enqRes] = await Promise.allSettled([
        orderService.getOrders(),
        sellerProductService.getSellerProducts(),
        enquiryService.getEnquiries(),
      ]);
      orders = ordRes.status === 'fulfilled' && Array.isArray(ordRes.value) ? ordRes.value : [];
      products = prodRes.status === 'fulfilled' && Array.isArray(prodRes.value) ? prodRes.value : [];
      enquiries = enqRes.status === 'fulfilled' && Array.isArray(enqRes.value) ? enqRes.value : [];
    } else {
      await delay(150);
      mockBase = db.getAnalytics() || {};
      orders = db.getOrders();
      products = db.getProducts();
      enquiries = db.getEnquiries();
    }

    // Dynamically calculate KPIs from authoritative dataset
    const totalRevenue = orders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
    const pendingOrders = orders.filter((o) =>
      ['new', 'pending', 'processing'].includes(String(o.orderStatus || '').toLowerCase())
    ).length;
    const lowStockCount = products.filter((p) => {
      const stock = Number(p.stock ?? p.stockQty ?? 0);
      const threshold = Number(p.lowStockThreshold ?? 10);
      return stock > 0 && stock <= threshold;
    }).length;
    const outOfStockCount = products.filter((p) => Number(p.stock ?? p.stockQty ?? 0) === 0).length;
    const activeProducts = products.filter(
      (p) => p.active !== false && String(p.status || '').toLowerCase() !== 'inactive'
    ).length;

    // Build category revenue / count breakdown from live products & orders
    const categoryMap = new Map();
    products.forEach((p) => {
      const cat = p.categoryName || p.category || 'Uncategorized';
      if (!categoryMap.has(cat)) {
        categoryMap.set(cat, { category: cat, count: 0, value: 0 });
      }
      const entry = categoryMap.get(cat);
      entry.count += 1;
      entry.value += Number(p.sellingPrice ?? p.price ?? 0) * Number(p.stock ?? p.stockQty ?? 0);
    });
    const categoryBreakdown = USE_MOCK_API
      ? mockBase.categoryBreakdown || Array.from(categoryMap.values())
      : Array.from(categoryMap.values());

    // Time-range specific trend data derived from real orders
    let revenueOverview = [];
    if (orders.length > 0) {
      if (startDate && endDate) {
        const start = new Date(startDate);
        const end = new Date(endDate);
        const diffDays = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
        const steps = Math.min(8, Math.max(4, diffDays));
        const stepDays = Math.max(1, Math.floor(diffDays / steps));

        revenueOverview = Array.from({ length: steps }).map((_, idx) => {
          const d = new Date(start.getTime() + idx * stepDays * 24 * 60 * 60 * 1000);
          const label = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
          const matchingOrders = orders.filter((o) => {
            const od = new Date(o.createdAt);
            return od <= d;
          });
          const rev = matchingOrders.reduce((sum, o) => sum + Number(o.totalAmount || 0), 0);
          return {
            label,
            revenue: rev,
            orders: matchingOrders.length,
            enquiries: enquiries.length,
          };
        });
      } else {
        revenueOverview = [
          { label: 'Current', revenue: totalRevenue, orders: orders.length, enquiries: enquiries.length },
        ];
      }
    }

    return {
      ...mockBase,
      categoryBreakdown,
      revenueOverview,
      kpis: {
        totalRevenue: totalRevenue || 0,
        totalOrders: orders.length || 0,
        pendingOrders: pendingOrders || 0,
        totalProducts: products.length || 0,
        activeProducts,
        lowStockCount,
        outOfStockCount,
        totalEnquiries: enquiries.length || 0,
        newEnquiries: enquiries.filter((e) => String(e.status || '').toLowerCase() === 'new').length || 0,
        conversionRate: enquiries.length > 0 ? Number(((orders.length / enquiries.length) * 100).toFixed(1)) : 0,
        averageOrderValue: orders.length > 0 ? Math.round(totalRevenue / orders.length) : 0,
      },
    };
  },
};
