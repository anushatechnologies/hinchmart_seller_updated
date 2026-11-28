import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { pricingService } from '../services/pricing.service';
import { useUIStore } from '../store/uiStore';

export function usePricing() {
  const queryClient = useQueryClient();
  const addToast = useUIStore(state => state.addToast);

  const query = useQuery({
    queryKey: ['pricing'],
    queryFn: () => pricingService.getPricingList(),
  });

  const updatePriceMutation = useMutation({
    mutationFn: ({ id, priceData }) => pricingService.updateProductPrice(id, priceData),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['pricing'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      addToast({
        title: 'Price Updated',
        message: 'Product pricing updated successfully',
        type: 'success',
      });
    },
    onError: (err) => {
      addToast({
        title: 'Failed to Update Price',
        message: err.message,
        type: 'error',
      });
    }
  });

  const bulkAdjustmentMutation = useMutation({
    mutationFn: (params) => pricingService.applyBulkPriceAdjustment(params),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['pricing'] });
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['seller-products'] });
      const count = res?.modifiedCount ?? res?.totalUpdated ?? 0;
      addToast({
        title: 'Bulk Pricing Applied',
        message: `Successfully adjusted pricing for ${count} products`,
        type: 'success',
      });
    },
    onError: (err) => {
      addToast({
        title: 'Bulk Pricing Failed',
        message: err?.message || 'Unable to apply bulk pricing adjustment',
        type: 'error',
      });
    },
  });

  return {
    ...query,
    pricingList: query.data || [],
    updateProductPrice: updatePriceMutation.mutateAsync,
    applyBulkAdjustment: bulkAdjustmentMutation.mutateAsync,
    isUpdating: updatePriceMutation.isPending,
    isBulkApplying: bulkAdjustmentMutation.isPending,
  };
}
