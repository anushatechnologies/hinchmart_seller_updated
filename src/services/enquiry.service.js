import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';
import { db } from '../mock/db.js';

function normalizeEnquiryItem(e) {
  return {
    ...e,
    id: e.enquiryId ? `enq_${e.enquiryId}` : e.id || `enq_${Date.now()}`,
    enquiryId: Number(e.enquiryId || String(e.id || '').replace(/^enq_/, '') || 0) || e.enquiryId,
    company: e.buyerCompany || e.buyerName || e.company || 'Buyer Company',
    buyerName: e.buyerName || e.buyer?.name || 'Buyer',
    productName: e.productTitle || e.productName || 'Material Requirement',
    quantityRequired: e.requestedQty ? `${e.requestedQty} ${e.unit || 'KG'}` : e.quantityRequired || '100 Units',
    targetPrice: e.targetPrice ? `₹${e.targetPrice}` : e.targetPrice || '₹800/unit',
    status: e.status || 'New',
  };
}

export const enquiryService = {
  /**
   * 5.1 GET /api/seller/enquiries (View Buyer RFQ Enquiries)
   */
  async getEnquiries(filters = {}) {
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/enquiries')) {
      try {
        const response = await apiClient.get('/api/seller/enquiries');
        const rawList = response.data?.data || response.data;
        if (Array.isArray(rawList)) {
          let list = rawList.map(normalizeEnquiryItem);
          if (filters.status && filters.status !== 'All') {
            list = list.filter((e) => String(e.status || '').toLowerCase() === filters.status.toLowerCase());
          }
          if (filters.search) {
            const q = filters.search.toLowerCase();
            list = list.filter(
              (e) =>
                (e.buyerName || '').toLowerCase().includes(q) ||
                (e.company || '').toLowerCase().includes(q) ||
                (e.productName || '').toLowerCase().includes(q)
            );
          }
          return list;
        }
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/enquiries');
        }
      }
    }

    if (!USE_MOCK_API) return [];

    await delay(100);
    let enquiries = db.getEnquiries();

    if (filters.status && filters.status !== 'All') {
      enquiries = enquiries.filter((e) => e.status.toLowerCase() === filters.status.toLowerCase());
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();
      enquiries = enquiries.filter(
        (e) =>
          (e.buyerName || '').toLowerCase().includes(q) ||
          (e.company || '').toLowerCase().includes(q) ||
          (e.productName || '').toLowerCase().includes(q)
      );
    }

    return enquiries;
  },

  async getEnquiryById(id) {
    const cleanId = String(id).replace(/^enq_/, '').trim();
    if (!USE_MOCK_API) {
      if (canAccessSellerApi('/api/seller/enquiries')) {
        try {
          const response = await apiClient.get(`/api/seller/enquiries/${cleanId}`);
          const data = response.data?.data || response.data;
          if (data && typeof data === 'object') return normalizeEnquiryItem(data);
        } catch (err) {
          if (err?.response?.status === 403) {
            markSellerApiForbidden('/api/seller/enquiries');
          }
        }
      }
      const list = await this.getEnquiries();
      const matched = (list || []).find((e) => String(e.id) === String(id) || String(e.enquiryId) === cleanId);
      if (matched) return matched;
      throw new Error('Enquiry not found');
    }

    await delay(150);
    const enquiry = db.getEnquiryById(id);
    if (!enquiry) throw new Error('Enquiry not found');
    return enquiry;
  },

  async updateEnquiryStatus(id, { status, quotationId }) {
    const cleanId = String(id).replace(/^enq_/, '').trim();
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/enquiries')) {
      try {
        const response = await apiClient.patch(`/api/seller/enquiries/${cleanId}/status`, { status, quotationId });
        const data = response.data?.data || response.data;
        if (data) return normalizeEnquiryItem(data);
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/enquiries');
        }
        throw new Error(err?.response?.data?.message || err?.message || 'Failed to update enquiry status.');
      }
    }

    await delay(200);
    return db.updateEnquiryStatus(id, status, quotationId);
  },
};
