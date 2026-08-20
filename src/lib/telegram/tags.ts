import { DocType } from '../ai/types';

/** Practical caption tags with reasonable spelling variations. */
const TAG_MAP: Record<string, DocType> = {
  order: 'ORDER_BOOK', orders: 'ORDER_BOOK', orderbook: 'ORDER_BOOK', order_book: 'ORDER_BOOK',
  supplier_challan: 'SUPPLIER_DELIVERY_CHALLAN', supplierchallan: 'SUPPLIER_DELIVERY_CHALLAN',
  challan: 'SUPPLIER_DELIVERY_CHALLAN', chalan: 'SUPPLIER_DELIVERY_CHALLAN', dc: 'SUPPLIER_DELIVERY_CHALLAN',
  supplier_bill: 'SUPPLIER_INVOICE', supplierbill: 'SUPPLIER_INVOICE', bill: 'SUPPLIER_INVOICE',
  invoice: 'SUPPLIER_INVOICE', tax_invoice: 'SUPPLIER_INVOICE',
  inward: 'INWARD_BOOK', aavak: 'INWARD_BOOK', avak: 'INWARD_BOOK', aavak_vahi: 'INWARD_BOOK', inward_book: 'INWARD_BOOK',
  ideal_challan: 'IDEAL_CUSTOMER_DELIVERY_CHALLAN', idealchallan: 'IDEAL_CUSTOMER_DELIVERY_CHALLAN',
  customer_challan: 'IDEAL_CUSTOMER_DELIVERY_CHALLAN', outward: 'IDEAL_CUSTOMER_DELIVERY_CHALLAN',
  shop_to_godown: 'SHOP_TO_GODOWN_TRANSFER', shoptogodown: 'SHOP_TO_GODOWN_TRANSFER', s2g: 'SHOP_TO_GODOWN_TRANSFER',
  godown_to_shop: 'GODOWN_TO_SHOP_TRANSFER', godowntoshop: 'GODOWN_TO_SHOP_TRANSFER', g2s: 'GODOWN_TO_SHOP_TRANSFER',
  pos: 'POS_SALES_FILE', sales: 'POS_SALES_FILE',
  adjustment: 'STOCK_ADJUSTMENT', correction: 'STOCK_ADJUSTMENT',
};

export function parseCaptionTag(caption: string | null | undefined): { tag: string; docType: DocType } | null {
  if (!caption) return null;
  const m = caption.match(/#([a-zA-Z_0-9]+)/);
  if (!m) return null;
  const key = m[1].toLowerCase();
  const docType = TAG_MAP[key];
  return docType ? { tag: `#${m[1]}`, docType } : null;
}
