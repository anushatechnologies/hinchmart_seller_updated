import { discountService } from './discount.service.js';
import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';
import { db } from '../mock/db.js';
import { sellerProductService } from './sellerProduct.service.js';

export const pricingService = {
  async getPricingList() {
    let products = [];
    if (USE_MOCK_API) {
      products = db.getSellerProducts();
    } else {
      try {
        const live = await sellerProductService.getSellerProducts();
        products = Array.isArray(live) ? live : [];
      } catch (_) {
        products = [];
      }
    }

    return products.map((p) => {
      const sellingPrice = Number(p.sellingPrice ?? p.price ?? 0);
      const mrp = Number(p.mrp ?? sellingPrice);
      return {
        id: p.id,
        productId: p.productId || p.id,
        name: p.title || p.name,
        title: p.title || p.name,
        sku: p.sku,
        category: p.category || p.categoryName || '',
        categoryId: p.categoryId ?? null,
        brand: p.brand || p.brandName || '',
        brandId: p.brandId ?? null,
        unit: p.unit,
        mrp,
        sellingPrice,
        wholesalePrice: Number(p.wholesalePrice ?? sellingPrice),
        dealerPrice: Number(p.dealerPrice ?? sellingPrice),
        pricingTiers: p.bulkPricingTiers || p.pricingTiers || [],
        gstRate: p.gstRate || 18,
        marginPercent: mrp > 0 ? Math.round(((mrp - sellingPrice) / mrp) * 100) : 0,
      };
    });
  },

  async updateProductPrice(id, priceData) {
    const cleanId = String(id).replace(/^sp_/, '').trim();
    const payload = {
      price: Number(priceData.price ?? priceData.sellingPrice),
      sellingPrice: Number(priceData.sellingPrice ?? priceData.price),
      mrp: Number(priceData.mrp ?? 0),
      wholesalePrice:
        priceData.wholesalePrice !== undefined ? Number(priceData.wholesalePrice) : undefined,
      bulkPricingTiers: priceData.bulkPricingTiers || priceData.pricingTiers || [],
    };

    if (!USE_MOCK_API) {
      try {
        let response;
        try {
          response = await apiClient.patch(`/api/seller/products/${cleanId}/pricing`, payload);
        } catch (err1) {
          if (err1?.response?.status === 403 || err1?.response?.status === 404) {
            try {
              response = await apiClient.put(`/api/seller/products/${cleanId}`, payload);
            } catch (err2) {
              response = await apiClient.put(`/api/products/${cleanId}`, payload);
            }
          } else {
            throw err1;
          }
        }
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (apiErr) {
        throw new Error(
          apiErr?.response?.data?.message || apiErr?.message || 'Failed to update product price on backend.'
        );
      }
    }

    await delay(100);
    return (
      db.updateSellerPrice(null, id, priceData) ||
      db.updateProduct(id, {
        sellingPrice: priceData.sellingPrice,
        price: priceData.sellingPrice,
        mrp: priceData.mrp,
        bulkPricingTiers: priceData.bulkPricingTiers || priceData.pricingTiers,
      })
    );
  },

  /**
   * 4.1 POST /api/seller/pricing/bulk-adjust
   */
  async applyBulkPriceAdjustment({ categoryId, brand, productIds, adjustmentType, value, applyTo }) {
    const products = USE_MOCK_API
      ? db.getSellerProducts()
      : await sellerProductService.getSellerProducts().catch(() => []);

    const matchingProducts = (Array.isArray(products) ? products : []).filter((p) => {
      if (Array.isArray(productIds) && productIds.length > 0) {
        return (
          productIds.includes(p.id) ||
          productIds.includes(Number(p.id)) ||
          productIds.includes(p.productId)
        );
      }
      let matches = true;
      if (categoryId && categoryId !== 'All') {
        const matchCat =
          String(p.categoryId) === String(categoryId) ||
          String(p.category || '').toLowerCase() === String(categoryId).toLowerCase() ||
          String(p.categoryName || '').toLowerCase() === String(categoryId).toLowerCase();
        if (!matchCat) matches = false;
      }
      if (brand && brand !== 'All') {
        const matchBrand =
          String(p.brandId) === String(brand) ||
          String(p.brand || p.brandName || '').toLowerCase() === String(brand).toLowerCase();
        if (!matchBrand) matches = false;
      }
      return matches;
    });

    const targetProductIds = matchingProducts
      .map((p) => Number(String(p.productId || p.id).replace(/^sp_/, '')) || p.id)
      .filter(Boolean);

    // Backend Enum: percentage_increase, percentage_decrease, fixed_increase, fixed_decrease
    const rawAdj = String(adjustmentType || '').toLowerCase();
    const isDecrease = rawAdj.includes('decrease') || Number(value) < 0;
    const isFixed = rawAdj.includes('fixed');
    const normAdjType = isFixed
      ? isDecrease
        ? 'fixed_decrease'
        : 'fixed_increase'
      : isDecrease
      ? 'percentage_decrease'
      : 'percentage_increase';

    // Backend Enum: selling_price, mrp, both
    const rawApply = String(applyTo || '').toLowerCase();
    const normApplyTo = rawApply === 'mrp' ? 'mrp' : rawApply === 'both' ? 'both' : 'selling_price';

    if (!USE_MOCK_API) {
      if (!canAccessSellerApi('/api/seller/pricing/bulk-adjust')) {
        throw new Error('Bulk pricing endpoint is restricted for this seller account.');
      }
      try {
        const response = await apiClient.post('/api/seller/pricing/bulk-adjust', {
          adjustmentType: normAdjType,
          applyTo: normApplyTo,
          value: Math.abs(Number(value) || 0),
          categoryId: categoryId && categoryId !== 'All' ? Number(categoryId) || undefined : undefined,
          brandId: brand && brand !== 'All' ? Number(brand) || undefined : undefined,
          productIds: targetProductIds.length > 0 ? targetProductIds : undefined,
        });
        const data = response.data?.data || response.data;
        if (data) {
          const modifiedCount =
            data.modifiedCount ?? data.totalUpdated ?? data.updatedCount ?? targetProductIds.length;
          return { ...data, modifiedCount, totalUpdated: modifiedCount };
        }
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/pricing/bulk-adjust');
        }
        throw new Error(
          apiErr?.response?.data?.message || apiErr?.message || 'Failed to apply bulk price adjustment.'
        );
      }
    }

    await delay(200);
    const numVal = Math.abs(Number(value) || 0);
    const signedDelta = isDecrease ? -numVal : numVal;
    const adjustments = [];
    matchingProducts.forEach((p) => {
      let newSellingPrice = Number(p.sellingPrice ?? p.price ?? 0);
      let newMrp = Number(p.mrp ?? newSellingPrice);

      if (!isFixed) {
        if (normApplyTo === 'selling_price' || normApplyTo === 'both') {
          newSellingPrice = Math.max(1, Math.round(newSellingPrice * (1 + signedDelta / 100)));
        }
        if (normApplyTo === 'mrp' || normApplyTo === 'both') {
          newMrp = Math.max(1, Math.round(newMrp * (1 + signedDelta / 100)));
        }
      } else {
        if (normApplyTo === 'selling_price' || normApplyTo === 'both') {
          newSellingPrice = Math.max(1, newSellingPrice + signedDelta);
        }
        if (normApplyTo === 'mrp' || normApplyTo === 'both') {
          newMrp = Math.max(1, newMrp + signedDelta);
        }
      }

      adjustments.push({ id: p.id, newSellingPrice, newMrp });
      db.updateSellerPrice(null, p.id, { sellingPrice: newSellingPrice, mrp: newMrp });
    });

    return {
      modifiedCount: adjustments.length,
      totalUpdated: adjustments.length,
      adjustments,
    };
  },

  async getDiscounts() {
    return discountService.getDiscounts();
  },

  async getDiscountById(id) {
    return discountService.getDiscountById(id);
  },

  async createDiscount(discountData) {
    return discountService.createDiscount(discountData);
  },

  async updateDiscount(id, discountData) {
    return discountService.updateDiscount(id, discountData);
  },

  async submitDiscountForReview(id) {
    return discountService.submitDiscountForReview(id);
  },
};

export { discountService };
