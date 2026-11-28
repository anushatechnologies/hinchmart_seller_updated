import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';

/**
 * Journey 9: Discounts & Promos Service
 * Controller: SellerDiscountController.java
 * Base Path: /api/seller/discounts
 */
export const discountService = {
  /**
   * 9.1 Create Seller Discount / Coupon
   * POST /api/seller/discounts
   */
  async createDiscount(discountData) {
    const payload = {
      code: String(discountData.code || '').trim().toUpperCase(),
      discountType: String(discountData.discountType || 'FIXED').toUpperCase(),
      discountValue: Number(discountData.discountValue || 0),
      startDate: discountData.startDate || new Date().toISOString().split('T')[0],
      endDate: discountData.endDate || new Date(Date.now() + 30 * 86400000).toISOString().split('T')[0],
      minimumOrderAmount: Number(discountData.minimumOrderAmount || 0),
      maxDiscountAmount: Number(discountData.maxDiscountAmount || discountData.discountValue || 0),
      ...discountData,
    };

    if (!USE_MOCK_API) {
      if (!canAccessSellerApi('/api/seller/discounts')) {
        throw new Error('Discount creation is currently restricted for this account.');
      }
      try {
        const response = await apiClient.post('/api/seller/discounts', payload);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/discounts');
        }
        throw new Error(err?.response?.data?.message || err?.message || 'Failed to create discount.');
      }
    }

    await delay(150);
    return {
      id: `disc_${Date.now()}`,
      discountId: Date.now() % 10000,
      ...payload,
      status: 'DRAFT',
      createdAt: new Date().toISOString(),
    };
  },

  /**
   * 9.2 Submit Discount for Review
   * PATCH /api/seller/discounts/{discountId}/submit
   */
  async submitDiscountForReview(discountId) {
    if (!USE_MOCK_API) {
      if (!canAccessSellerApi('/api/seller/discounts')) {
        throw new Error('Discount submission is currently restricted for this account.');
      }
      try {
        const response = await apiClient.patch(`/api/seller/discounts/${discountId}/submit`);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/discounts');
        }
        throw new Error(err?.response?.data?.message || err?.message || 'Failed to submit discount for review.');
      }
    }

    await delay(150);
    return {
      id: discountId,
      status: 'PENDING_REVIEW',
      message: 'Discount submitted for admin review.',
    };
  },

  /**
   * List Seller Discounts
   * GET /api/seller/discounts
   */
  async getDiscounts() {
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/discounts')) {
      try {
        const response = await apiClient.get('/api/seller/discounts');
        const list = response.data?.data || response.data;
        if (Array.isArray(list)) return list;
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/discounts');
        } else {
          console.warn('GET /api/seller/discounts notice:', err?.message);
        }
      }
    }

    if (!USE_MOCK_API) return [];

    await delay(100);
    return [];
  },

  /**
   * Get Single Discount Details
   * GET /api/seller/discounts/{id}
   */
  async getDiscountById(id) {
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/discounts')) {
      try {
        const response = await apiClient.get(`/api/seller/discounts/${id}`);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/discounts');
        }
      }
    }

    await delay(100);
    return null;
  },

  /**
   * Update Discount Details
   * PUT /api/seller/discounts/{id}
   */
  async updateDiscount(id, discountData) {
    if (!USE_MOCK_API) {
      if (!canAccessSellerApi('/api/seller/discounts')) {
        throw new Error('Discount update is currently restricted for this account.');
      }
      try {
        const response = await apiClient.put(`/api/seller/discounts/${id}`, discountData);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/discounts');
        }
        throw new Error(err?.response?.data?.message || err?.message || 'Failed to update discount.');
      }
    }

    await delay(150);
    return { id, ...discountData };
  },
};

export default discountService;
