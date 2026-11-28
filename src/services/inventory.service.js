import { apiClient, delay, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './apiClient.js';
import { db } from '../mock/db.js';
import { sellerProductService } from './sellerProduct.service.js';

export const inventoryService = {
  async getInventory(filters = {}) {
    let products = [];
    try {
      products = await sellerProductService.getSellerProducts();
    } catch (err) {
      products = null;
    }
    if (!Array.isArray(products)) {
      products = USE_MOCK_API ? db.getSellerProducts() : [];
    }

    const warehouses = await this.getWarehouses();

    let list = (Array.isArray(products) ? products : []).map((p) => {
      const wh =
        warehouses.find(
          (w) => String(w.id) === String(p.warehouseId) || String(w.warehouseId) === String(p.warehouseId)
        ) || warehouses[0];
      const stock = Number(p.stock ?? p.stockQty ?? 0);
      const lowStockThreshold = Number(p.lowStockThreshold ?? 10);
      const isLowStock = stock > 0 && stock <= lowStockThreshold;
      const isOutOfStock = stock === 0;
      const price = Number(p.sellingPrice ?? p.price ?? 0);

      return {
        id: p.id,
        productId: p.productId || p.id,
        name: p.title || p.name || 'Untitled Product',
        title: p.title || p.name || 'Untitled Product',
        sku: p.sku || 'N/A',
        category: p.category || p.categoryName || '',
        brand: p.brand || p.brandName || '',
        unit: p.unit || 'PIECE',
        availableStock: stock,
        stock,
        reservedStock: Number(p.reservedStock || 0),
        lowStockThreshold,
        price,
        sellingPrice: price,
        mrp: Number(p.mrp || price),
        warehouseName: wh ? wh.name : 'Primary Seller Hub',
        warehouseId: p.warehouseId || wh?.id || 'wh_1',
        isLowStock,
        isOutOfStock,
        status: isOutOfStock ? 'Out of Stock' : isLowStock ? 'Low Stock' : 'In Stock',
        updatedAt: p.updatedAt,
      };
    });

    if (filters.warehouseId && filters.warehouseId !== 'All') {
      list = list.filter((item) => String(item.warehouseId) === String(filters.warehouseId));
    }

    if (filters.status && filters.status !== 'All') {
      list = list.filter((item) => (item.status || '').toLowerCase() === filters.status.toLowerCase());
    }

    if (filters.search) {
      const q = filters.search.toLowerCase();
      list = list.filter(
        (item) =>
          (item.name || '').toLowerCase().includes(q) ||
          (item.sku && item.sku.toLowerCase().includes(q)) ||
          (item.category && item.category.toLowerCase().includes(q)) ||
          (item.warehouseName && item.warehouseName.toLowerCase().includes(q))
      );
    }

    return list;
  },

  async getStockAlerts() {
    const inventory = await this.getInventory();
    const lowStock = inventory.filter((p) => p.isLowStock && p.availableStock > 0);
    const outOfStock = inventory.filter((p) => p.isOutOfStock || p.availableStock === 0);

    return {
      totalAlerts: lowStock.length + outOfStock.length,
      lowStockCount: lowStock.length,
      outOfStockCount: outOfStock.length,
      lowStockItems: lowStock,
      outOfStockItems: outOfStock,
    };
  },

  async updateStock(productId, adjustment) {
    const cleanProductId = String(productId).replace(/^sp_/, '').trim();
    let currentProd = db.findProductById(productId) || db.getSellerProductById(null, productId);

    let oldStock =
      typeof adjustment === 'object' && adjustment !== null && adjustment.currentStock !== undefined
        ? Number(adjustment.currentStock)
        : typeof adjustment === 'object' && adjustment !== null && adjustment.oldStock !== undefined
        ? Number(adjustment.oldStock)
        : currentProd
        ? Number(currentProd.stock ?? currentProd.stockQty ?? 0)
        : null;

    if (oldStock === null && !USE_MOCK_API) {
      try {
        const liveProd = await sellerProductService.getSellerProductById(cleanProductId);
        if (liveProd) {
          currentProd = liveProd;
          oldStock = Number(liveProd.stock ?? liveProd.stockQty ?? 0);
        }
      } catch (_) {}
    }

    const baseStock = Number.isFinite(oldStock) ? oldStock : 0;

    let newStock;
    let reason = 'Manual Stock Adjustment';
    let qty = 0;
    let normType = 'RESTOCK';

    if (typeof adjustment === 'object' && adjustment !== null) {
      reason = adjustment.reason || reason;
      const adjustQty = Number(adjustment.quantity) || 0;
      if (adjustment.adjustmentType === 'add') {
        newStock = baseStock + adjustQty;
        qty = adjustQty;
        normType = 'RESTOCK';
      } else if (adjustment.adjustmentType === 'subtract') {
        newStock = Math.max(0, baseStock - adjustQty);
        qty = adjustQty;
        normType = 'DAMAGED';
      } else if (adjustment.adjustmentType === 'set') {
        newStock = Math.max(0, adjustQty);
        qty = newStock;
        normType = newStock >= baseStock ? 'RESTOCK' : 'DAMAGED';
      } else {
        newStock = Number(adjustment.newStock ?? adjustment.stock ?? adjustQty);
        qty = Math.abs(newStock - baseStock);
        normType = newStock >= baseStock ? 'RESTOCK' : 'DAMAGED';
      }
    } else {
      newStock = parseInt(adjustment, 10);
      qty = Math.abs(newStock - baseStock);
      normType = newStock >= baseStock ? 'RESTOCK' : 'DAMAGED';
    }

    if (isNaN(newStock) || newStock < 0) {
      throw new Error('Stock quantity must be a non-negative number');
    }

    if (!USE_MOCK_API) {
      let stockSaved = false;
      let lastError = null;

      // 1. Direct stock update: PATCH /api/seller/products/{id}/stock
      if (canAccessSellerApi('/api/seller/products')) {
        try {
          await apiClient.patch(`/api/seller/products/${cleanProductId}/stock`, { stockQty: newStock });
          stockSaved = true;
        } catch (err) {
          lastError = err;
        }
      }

      // 2. Inventory adjust ledger: POST /api/seller/inventory/adjust
      if (canAccessSellerApi('/api/seller/inventory/adjust')) {
        try {
          const adjustType =
            typeof adjustment === 'object' && adjustment?.adjustmentType
              ? adjustment.adjustmentType
              : 'set';
          await apiClient.post('/api/seller/inventory/adjust', {
            productId: Number(cleanProductId) || cleanProductId,
            warehouseId: Number(adjustment?.warehouseId) || 1,
            adjustmentType: adjustType,
            quantity: adjustType === 'set' ? newStock : qty,
            stockQty: newStock,
            reason,
          });
          stockSaved = true;
        } catch (apiErr) {
          if (apiErr?.response?.status === 403) {
            markSellerApiForbidden('/api/seller/inventory/adjust');
          }
          if (!lastError) lastError = apiErr;
        }
      }

      if (!stockSaved && lastError) {
        throw new Error(
          lastError?.response?.data?.message || lastError?.message || 'Failed to update stock balance on backend.'
        );
      }
    }

    try {
      db.updateSellerStock(null, productId, newStock);
    } catch (_) {}

    const updated = db.findProductById(productId) || db.getSellerProductById(null, productId);

    return {
      id: cleanProductId,
      productId: cleanProductId,
      name: updated?.title || updated?.name || currentProd?.title || currentProd?.name || 'Product',
      stock: newStock,
      unit: updated?.unit || currentProd?.unit || 'PIECE',
      quantity: qty,
      adjustmentType: normType,
      reason,
    };
  },

  async adjustStock(productId, newStock, reason = 'Inventory Count') {
    return this.updateStock(productId, { adjustmentType: 'set', quantity: newStock, reason });
  },

  /**
   * 3.1 GET /api/seller/warehouses
   */
  async getWarehouses() {
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/warehouses')) {
      try {
        const response = await apiClient.get('/api/seller/warehouses');
        const rawList = response.data?.data || response.data;
        if (Array.isArray(rawList)) {
          return rawList.map((w) => ({
            ...w,
            id: w.id || `wh_${w.warehouseId || 1}`,
            warehouseId: w.warehouseId ?? w.id,
          }));
        }
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/warehouses');
        }
      }
    }

    if (!USE_MOCK_API) return [];

    await delay(50);
    return db.getWarehouses();
  },

  /**
   * 3.2 POST /api/seller/warehouses
   */
  async createWarehouse(whData) {
    if (!USE_MOCK_API) {
      if (!canAccessSellerApi('/api/seller/warehouses')) {
        throw new Error('Warehouse management is restricted until seller verification completes.');
      }
      try {
        const response = await apiClient.post('/api/seller/warehouses', whData);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/warehouses');
        }
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to create warehouse.');
      }
    }

    await delay(100);
    return db.createWarehouse(whData);
  },

  async updateWarehouse(id, updates) {
    const cleanId = String(id).replace(/^wh_/, '').trim();
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/warehouses')) {
      try {
        const response = await apiClient.put(`/api/seller/warehouses/${cleanId}`, updates);
        const data = response.data?.data || response.data;
        if (data) return data;
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/warehouses');
        }
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to update warehouse.');
      }
    }
    await delay(150);
    return db.updateWarehouse(id, updates);
  },

  async deleteWarehouse(id) {
    const cleanId = String(id).replace(/^wh_/, '').trim();
    if (!USE_MOCK_API && canAccessSellerApi('/api/seller/warehouses')) {
      try {
        await apiClient.delete(`/api/seller/warehouses/${cleanId}`);
        return true;
      } catch (apiErr) {
        if (apiErr?.response?.status === 403) {
          markSellerApiForbidden('/api/seller/warehouses');
        }
        throw new Error(apiErr?.response?.data?.message || apiErr?.message || 'Failed to delete warehouse.');
      }
    }
    await delay(150);
    return db.deleteWarehouse(id);
  },
};
