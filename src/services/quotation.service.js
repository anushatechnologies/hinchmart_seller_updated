import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';
import { db } from '../mock/db.js';
import { enquiryService } from './enquiry.service.js';

function normalizeQuotationItem(q) {
  return {
    ...q,
    id: q.quotationId ? `quot_${q.quotationId}` : q.id || `quot_${Date.now()}`,
    quotationId: Number(q.quotationId || String(q.id || '').replace(/^quot_/, '')) || q.quotationId,
    quotationNumber: q.quotationNumber || `QTN-${q.quotationId || q.id || '101'}`,
    buyer: {
      name: q.buyerName || q.buyer?.name || 'Buyer',
      company: q.buyerCompany || q.buyer?.company || q.buyerName || 'Client Ltd',
      email: q.buyerEmail || q.buyer?.email || '',
      phone: q.buyerPhone || q.buyer?.phone || '',
    },
    total: q.grandTotal ?? q.total ?? 0,
  };
}

export const quotationService = {
  /**
   * 6.3 GET /api/seller/quotations
   */
  async getQuotations(filters = {}) {
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/quotations')) {
      try {
        const response = await apiClient.get('/api/seller/quotations');
        const rawList = response.data?.data || response.data;
        if (Array.isArray(rawList)) {
          let mapped = rawList.map(normalizeQuotationItem);
          if (filters.status && filters.status !== 'All') {
            mapped = mapped.filter((q) => String(q.status || '').toLowerCase() === filters.status.toLowerCase());
          }
          if (filters.search) {
            const q = filters.search.toLowerCase();
            mapped = mapped.filter(
              (item) =>
                (item.quotationNumber || '').toLowerCase().includes(q) ||
                (item.buyer?.company || '').toLowerCase().includes(q) ||
                (item.buyer?.name || '').toLowerCase().includes(q)
            );
          }
          return mapped;
        }
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/quotations');
        }
      }
    }

    if (!USE_MOCK_API) return [];

    await delay(100);
    let quotations = db.getQuotations();

    if (filters.status && filters.status !== 'All') {
      quotations = quotations.filter((q) => q.status.toLowerCase() === filters.status.toLowerCase());
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();
      quotations = quotations.filter(
        (item) =>
          (item.quotationNumber || '').toLowerCase().includes(q) ||
          (item.buyer?.company || '').toLowerCase().includes(q) ||
          (item.buyer?.name || '').toLowerCase().includes(q)
      );
    }

    return quotations;
  },

  async getQuotationById(id) {
    const cleanId = String(id).replace(/^quot_/, '').trim();
    if (!USE_MOCK_API) {
      if (canAccessSellerApi('/api/seller/quotations')) {
        try {
          const response = await apiClient.get(`/api/seller/quotations/${cleanId}`);
          const data = response.data?.data || response.data;
          if (data && typeof data === 'object') return normalizeQuotationItem(data);
        } catch (err) {
          if (err?.response?.status === 403) {
            markSellerApiForbidden('/api/seller/quotations');
          }
        }
      }

      const list = await this.getQuotations();
      const matched = (list || []).find(
        (q) =>
          String(q.id) === String(id) ||
          String(q.quotationId) === cleanId ||
          String(q.quotationNumber) === String(id)
      );
      if (matched) return matched;
      throw new Error('Quotation not found');
    }

    await delay(100);
    const quotation = db.getQuotationById(id);
    if (!quotation) throw new Error('Quotation not found');
    return quotation;
  },

  /**
   * 5.2 POST /api/seller/quotations (Submit Quotation Proposal to Buyer)
   * Request Body: { enquiryId, quotedPricePerUnit, validUntil, notes }
   */
  async createQuotation(quotationData) {
    const enquiryId = Number(String(quotationData.enquiryId || '').replace(/^enq_/, '')) || 142;
    const quotedPricePerUnit = Number(
      quotationData.quotedPricePerUnit ?? quotationData.pricePerUnit ?? quotationData.items?.[0]?.unitPrice ?? 810.0
    );
    const rawValidUntil =
      quotationData.validUntil ||
      new Date(Date.now() + (Number(quotationData.validityDays) || 15) * 86400000).toISOString();
    const validUntil = String(rawValidUntil).includes('T')
      ? String(rawValidUntil).split('T')[0]
      : String(rawValidUntil);
    const notes = quotationData.notes || quotationData.termsAndConditions || 'Includes free delivery to industrial zone';

    const payload = {
      enquiryId,
      quotedPricePerUnit,
      validUntil,
      notes,
      freightCharges: Number(quotationData.freightCharges || quotationData.freightCharge || 0),
      paymentTerms: quotationData.paymentTerms || '50% Advance, 50% on Delivery',
      deliveryTimeline: quotationData.deliveryTimeline || 'Within 48 hours of PO',
      buyerName: quotationData.buyerName || quotationData.buyer?.name || 'Buyer',
      buyerEmail: quotationData.buyerEmail || quotationData.buyer?.email || 'buyer@example.com',
      buyerPhone: quotationData.buyerPhone || quotationData.buyer?.phone || '+91 98765 12345',
      validityDays: Number(quotationData.validityDays || 15),
      freightCharge: Number(quotationData.freightCharge || quotationData.freightCharges || 0),
      items: (quotationData.items || []).map((i) => ({
        productId: Number(String(i.productId || '').replace(/^sp_/, '')) || i.productId || 1,
        productTitle: i.productTitle || i.name || i.productName || 'Product',
        productName: i.productName || i.productTitle || i.name || 'Product',
        quantity: Number(i.quantity || 1),
        unitPrice: Number(i.unitPrice || i.price || quotedPricePerUnit),
        gstRate: Number(i.gstRate || 18),
      })),
    };

    if (!USE_MOCK_API) {
      try {
        const response = await apiClient.post('/api/seller/quotations', payload);
        const data = response.data?.data || response.data;
        if (data) return normalizeQuotationItem(data);
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/quotations');
        }
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to create quotation.');
      }
    }

    await delay(300);
    return db.createQuotation(quotationData);
  },

  async updateQuotation(id, updates) {
    const cleanId = String(id).replace(/^quot_/, '').trim();
    if (!USE_MOCK_API) {
      try {
        const response = await apiClient.put(`/api/seller/quotations/${cleanId}`, updates);
        const data = response.data?.data || response.data;
        if (data) return normalizeQuotationItem(data);
      } catch (apiErr) {
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to update quotation.');
      }
    }
    await delay(250);
    return db.updateQuotation(id, updates);
  },

  async deleteQuotation(id) {
    const cleanId = String(id).replace(/^quot_/, '').trim();
    if (!USE_MOCK_API) {
      try {
        await apiClient.delete(`/api/seller/quotations/${cleanId}`);
        return true;
      } catch (apiErr) {
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to delete quotation.');
      }
    }
    await delay(200);
    return db.deleteQuotation(id);
  },

  /**
   * 5.1 GET /api/seller/enquiries (View Buyer RFQ Enquiries - /quotations/enquiries was 404)
   */
  async getEnquiries() {
    return enquiryService.getEnquiries();
  },
};
