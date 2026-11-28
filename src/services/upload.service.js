import { apiClient, USE_MOCK_API, canAccessSellerApi, markSellerApiForbidden } from './api.js';
import { db } from '../mock/db.js';
import { compressImageFile } from '../utils/imageCompressor.js';

// Helper to convert a File/Blob to a persistent Base64 Data URL
function fileToBase64(file) {
  return new Promise((resolve) => {
    if (!file || typeof FileReader === 'undefined') {
      resolve(null);
      return;
    }
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target?.result || null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

export const uploadService = {
  /**
   * Phase 1: Upload Single Product Image to AWS S3
   * Endpoint: POST /api/images/products (multipart/form-data: file)
   * Fallback: POST /api/images/upload?folder=products
   * Returns: { success: true, url, imageUrl, fileUrl, imageKey, fileName, fileSize }
   */
  async uploadProductImage(file, onProgress) {
    if (!file) throw new Error('No file provided');

    // 15 MB limit as specified in Spring Boot ImageUploadController
    const maxSize = 15 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error(`File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 15MB.`);
    }

    if (!USE_MOCK_API && canAccessSellerApi('/api/images/products')) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', 'products');

        let res;
        try {
          res = await apiClient.post('/api/images/products', formData, {
            timeout: 25000,
            onUploadProgress: (e) => {
              if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
            },
          });
        } catch (err1) {
          if (err1?.response?.status === 403) {
            markSellerApiForbidden('/api/images/products');
            markSellerApiForbidden('/api/images/upload');
            throw err1;
          }
          if (canAccessSellerApi('/api/images/upload')) {
            res = await apiClient.post('/api/images/upload?folder=products', formData, {
              timeout: 25000,
              onUploadProgress: (e) => {
                if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
              },
            });
          }
        }

        const data = res?.data?.data || res?.data;
        const url = data?.imageUrl || data?.fileUrl || data?.url;
        if (url) {
          if (onProgress) onProgress(100);
          return {
            success: true,
            fileUrl: url,
            imageUrl: url,
            url,
            imageKey: data?.imageKey || data?.key,
            fileName: data?.fileName || file.name,
            fileSize: data?.fileSize || file.size,
          };
        }
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/images/products');
          markSellerApiForbidden('/api/images/upload');
        }
      }
    }

    // Local / mock fallback
    let base64Url = null;
    try {
      base64Url = await compressImageFile(file, { maxDim: 800, quality: 0.75 });
    } catch (_) {}
    if (!base64Url) {
      base64Url = await fileToBase64(file);
    }
    if (onProgress) onProgress(100);
    return {
      success: true,
      url: base64Url,
      imageUrl: base64Url,
      fileUrl: base64Url,
      fileName: file.name,
      fileSize: file.size,
      isLocalPreview: true,
    };
  },

  /**
   * Phase 1b: Upload Multiple Product Images to AWS S3
   * Endpoint: POST /api/images/multiple?folder=products (multipart/form-data: files)
   */
  async uploadMultipleProductImages(files, onProgress) {
    if (!files || !files.length) return [];
    if (!USE_MOCK_API && canAccessSellerApi('/api/images/multiple')) {
      try {
        const formData = new FormData();
        Array.from(files).forEach((f) => formData.append('files', f));
        formData.append('folder', 'products');

        let res;
        try {
          res = await apiClient.post('/api/images/multiple?folder=products', formData, {
            timeout: 45000,
            onUploadProgress: (e) => {
              if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
            },
          });
        } catch (err1) {
          if (err1?.response?.status === 403) {
            markSellerApiForbidden('/api/images/multiple');
            throw err1;
          }
          res = await apiClient.post('/api/images/multiple', formData, {
            timeout: 45000,
            onUploadProgress: (e) => {
              if (onProgress && e.total) onProgress(Math.round((e.loaded * 100) / e.total));
            },
          });
        }

        const data = res.data?.data || res.data;
        if (Array.isArray(data)) {
          return data.map((d) => d?.imageUrl || d?.fileUrl || d?.url || d).filter(Boolean);
        }
        if (data?.files && Array.isArray(data.files)) {
          return data.files.map((d) => d?.imageUrl || d?.fileUrl || d?.url || d).filter(Boolean);
        }
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/images/multiple');
        } else {
          console.warn('Backend multiple image upload notice:', err?.message);
        }
      }
    }

    const uploaded = [];
    for (const f of files) {
      const res = await this.uploadProductImage(f, onProgress);
      if (res?.url) uploaded.push(res.url);
    }
    return uploaded;
  },

  /**
   * Helper to convert Base64/DataURL/Blob to a File and upload to S3
   */
  async uploadBase64Image(base64Data, filename = 'product_image.webp') {
    if (!base64Data || typeof base64Data !== 'string') return null;
    if (!canAccessSellerApi('/api/images/products')) {
      return { success: true, url: base64Data, imageUrl: base64Data, fileUrl: base64Data };
    }
    try {
      const arr = base64Data.split(',');
      const mime = arr[0].match(/:(.*?);/)?.[1] || 'image/webp';
      const bstr = atob(arr[1] || arr[0]);
      let n = bstr.length;
      const u8arr = new Uint8Array(n);
      while (n--) {
        u8arr[n] = bstr.charCodeAt(n);
      }
      const file = new File([u8arr], filename, { type: mime });
      const res = await this.uploadProductImage(file);
      return res || { success: true, url: base64Data, imageUrl: base64Data };
    } catch (e) {
      return { success: true, url: base64Data, imageUrl: base64Data };
    }
  },

  /**
   * General upload delegator for backwards compatibility
   */
  async uploadFile(file, onProgress, type = 'products') {
    if (!file) throw new Error('No file provided');
    if (type === 'products') {
      return this.uploadProductImage(file, onProgress);
    }

    const maxSize = 15 * 1024 * 1024;
    if (file.size > maxSize) {
      throw new Error(`File size (${(file.size / (1024 * 1024)).toFixed(1)}MB) exceeds maximum limit of 15MB.`);
    }

    const isImage = file.type?.startsWith('image/') || /\.(png|jpe?g|webp|svg)$/i.test(file.name || '');

    if (!USE_MOCK_API && canAccessSellerApi('/api/images/upload')) {
      try {
        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', type);

        const uploadConfig = {
          timeout: 20000,
          onUploadProgress: (progressEvent) => {
            if (onProgress && progressEvent.total) {
              const percentCompleted = Math.round((progressEvent.loaded * 100) / progressEvent.total);
              onProgress(percentCompleted);
            }
          },
        };

        let response;
        try {
          response = await apiClient.post(
            `/api/images/upload?folder=${encodeURIComponent(type)}`,
            formData,
            uploadConfig
          );
        } catch (err1) {
          if (err1?.response?.status === 403) {
            markSellerApiForbidden('/api/images/upload');
            throw err1;
          }
          response = await apiClient.post(
            `/api/images/upload?type=${encodeURIComponent(type)}`,
            formData,
            uploadConfig
          );
        }

        const data = response.data?.data || response.data;
        const imageUrl = data?.imageUrl || data?.fileUrl || data?.url;
        const key = data?.imageKey || data?.key || null;

        if (imageUrl) {
          if (onProgress) onProgress(100);
          return {
            success: true,
            fileName: file.name || data.fileName,
            fileSize: `${((file.size || data.fileSize || 0) / (1024 * 1024)).toFixed(2)} MB`,
            url: imageUrl,
            imageUrl,
            fileUrl: imageUrl,
            key,
            isImage,
          };
        }
      } catch (err) {
        if (err?.response?.status === 403) {
          markSellerApiForbidden('/api/images/upload');
        }
      }
    }

    let base64Url = null;
    try {
      base64Url = await compressImageFile(file, { maxDim: 800, quality: 0.75 });
    } catch (_) {}
    if (!base64Url) {
      base64Url = await fileToBase64(file);
    }

    if (onProgress) onProgress(100);
    return {
      success: true,
      fileName: file.name,
      fileSize: `${((file.size || 0) / (1024 * 1024)).toFixed(2)} MB`,
      url: base64Url,
      imageUrl: base64Url,
      fileUrl: base64Url,
      isImage,
      isLocalPreview: true,
    };
  }
};

export default uploadService;
