export interface ShopifyConfig {
  storeName: string;
  accessToken: string;
}

export interface Product {
  id: string;
  title: string;
  handle: string;
  status: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
  vendor: string;
  productType: string;
  createdAt: string;
  updatedAt: string;
  publishedAt?: string;
  descriptionHtml: string;
  tags: string[];
  variants: ProductVariant[];
  media: ProductMedia[];
  inventoryQuantity?: number;
}

export interface ProductVariant {
  id: string;
  title: string;
  price: string;
  compareAtPrice?: string;
  sku?: string;
  barcode?: string;
  inventoryQuantity: number;
  inventoryItem: {
    id: string;
  };
  position: number;
  availableForSale: boolean;
}

export interface ProductMedia {
  id: string;
  mediaContentType: string;
  image?: {
    url: string;
    altText?: string;
  };
}

export interface Location {
  id: string;
  name: string;
  address: {
    address1?: string;
    address2?: string;
    city?: string;
    province?: string;
    country?: string;
    zip?: string;
  };
  active: boolean;
}

export interface InventoryLevel {
  id: string;
  available: number;
  location: Location;
  inventoryItem: {
    id: string;
  };
}

// Enhanced GraphQL Queries

export const GET_PRODUCTS_QUERY = `
  query getProducts($first: Int, $after: String, $query: String) {
    products(first: $first, after: $after, query: $query) {
      edges {
        node {
          id
          title
          handle
          status
          vendor
          productType
          createdAt
          updatedAt
          publishedAt
          descriptionHtml
          tags
          variants(first: 10) {
            edges {
              node {
                id
                title
                price
                compareAtPrice
                sku
                barcode
                inventoryQuantity
                inventoryItem {
                  id
                }
                position
                availableForSale
              }
            }
          }
          media(first: 5) {
            edges {
              node {
                id
                mediaContentType
                ... on MediaImage {
                  image {
                    url
                    altText
                  }
                }
              }
            }
          }
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_PRODUCT_BY_ID_QUERY = `
  query getProduct($id: ID!) {
    product(id: $id) {
      id
      title
      handle
      status
      vendor
      productType
      createdAt
      updatedAt
      publishedAt
      descriptionHtml
      tags
      variants(first: 50) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            sku
            barcode
            inventoryQuantity
            inventoryItem {
              id
            }
            position
            availableForSale
          }
        }
      }
      media(first: 10) {
        edges {
          node {
            id
            mediaContentType
            ... on MediaImage {
              image {
                url
                altText
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_PRODUCT_BY_HANDLE_QUERY = `
  query getProductByHandle($handle: String!) {
    productByHandle(handle: $handle) {
      id
      title
      handle
      status
      vendor
      productType
      createdAt
      updatedAt
      publishedAt
      descriptionHtml
      tags
      variants(first: 50) {
        edges {
          node {
            id
            title
            price
            compareAtPrice
            sku
            barcode
            inventoryQuantity
            inventoryItem {
              id
            }
            position
            availableForSale
          }
        }
      }
      media(first: 10) {
        edges {
          node {
            id
            mediaContentType
            ... on MediaImage {
              image {
                url
                altText
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_LOCATIONS_QUERY = `
  query getLocations($first: Int, $after: String, $includeInactive: Boolean) {
    locations(first: $first, after: $after, includeInactive: $includeInactive) {
      edges {
        node {
          id
          name
          address {
            address1
            address2
            city
            province
            country
            zip
          }
          isActive
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`;

export const GET_INVENTORY_LEVELS_QUERY = `
  query getInventoryLevels($inventoryItemIds: [ID!]!) {
    inventoryItems(first: 250, query: \\"gid:$inventoryItemIds\\") {
      edges {
        node {
          id
          sku
          tracked
          inventoryLevels(first: 50) {
            edges {
              node {
                id
                available
                location {
                  id
                  name
                  isActive
                }
              }
            }
          }
        }
      }
    }
  }
`;

export const GET_PRODUCT_VARIANTS_INVENTORY_QUERY = `
  query getProductVariantsInventory($productId: ID!) {
    product(id: $productId) {
      id
      title
      variants(first: 100) {
        edges {
          node {
            id
            sku
            inventoryItem {
              id
              tracked
              inventoryLevels(first: 50) {
                edges {
                  node {
                    id
                    available
                    location {
                      id
                      name
                      isActive
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
`;

// Enhanced GraphQL Mutations

export const PRODUCT_UPDATE_MUTATION = `
  mutation productUpdate($id: ID!, $input: ProductInput!) {
    productUpdate(id: $id, input: $input) {
      product {
        id
        title
        handle
        status
        vendor
        productType
        descriptionHtml
        tags
        updatedAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const PRODUCT_DELETE_MUTATION = `
  mutation productDelete($input: ProductDeleteInput!) {
    productDelete(input: $input) {
      deletedProductId
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const PRODUCT_ARCHIVE_MUTATION = `
  mutation productUpdate($id: ID!, $input: ProductInput!) {
    productUpdate(id: $id, input: $input) {
      product {
        id
        title
        status
        updatedAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const PRODUCT_UNARCHIVE_MUTATION = `
  mutation productUpdate($id: ID!, $input: ProductInput!) {
    productUpdate(id: $id, input: $input) {
      product {
        id
        title
        status
        updatedAt
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const INVENTORY_ADJUST_QUANTITIES_MUTATION = `
  mutation inventoryAdjustQuantities($input: InventoryAdjustQuantitiesInput!) {
    inventoryAdjustQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
          item {
            id
          }
          location {
            id
            name
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const INVENTORY_SET_QUANTITIES_MUTATION = `
  mutation inventorySetQuantities($input: InventorySetQuantitiesInput!) {
    inventorySetQuantities(input: $input) {
      inventoryAdjustmentGroup {
        id
        createdAt
        reason
        referenceDocumentUri
        changes {
          name
          delta
          quantityAfterChange
          item {
            id
          }
          location {
            id
            name
          }
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const INVENTORY_ACTIVATE_MUTATION = `
  mutation inventoryActivate(
    $inventoryItemId: ID!
    $locationId: ID!
    $available: Int
    $onHand: Int
  ) {
    inventoryActivate(
      inventoryItemId: $inventoryItemId
      locationId: $locationId
      available: $available
      onHand: $onHand
    ) {
      inventoryLevel {
        id
        available
        location {
          id
          name
        }
        item {
          id
        }
      }
      userErrors {
        field
        message
        code
      }
    }
  }
`;

export const INVENTORY_DEACTIVATE_MUTATION = `
  mutation inventoryDeactivate($inventoryLevelId: ID!) {
    inventoryDeactivate(inventoryLevelId: $inventoryLevelId) {
      userErrors {
        field
        message
        code
      }
    }
  }
`;

// Product input interfaces for mutations

export interface ProductInput {
  title?: string;
  handle?: string;
  descriptionHtml?: string;
  vendor?: string;
  productType?: string;
  tags?: string[];
  status?: 'ACTIVE' | 'ARCHIVED' | 'DRAFT';
}

export interface ProductDeleteInput {
  id: string;
}

export interface InventoryQuantityInput {
  availableQuantity?: number;
  inventoryItemId: string;
  locationId: string;
}

export interface InventoryAdjustQuantitiesInput {
  reason: string;
  referenceDocumentUri?: string;
  changes: Array<{
    delta: number;
    inventoryItemId: string;
    locationId: string;
    name?: string;
  }>;
}

export interface InventorySetQuantitiesInput {
  reason: string;
  referenceDocumentUri?: string;
  quantities: Array<{
    quantity: number;
    inventoryItemId: string;
    locationId: string;
    name?: string;
  }>;
}

// Query builder utilities

export class ShopifyQueryBuilder {
  /**
   * Build a query string for filtering products
   */
  static buildProductQuery(filters: {
    title?: string;
    vendor?: string;
    productType?: string;
    tag?: string;
    status?: 'active' | 'archived' | 'draft';
    sku?: string;
    createdAtMin?: string;
    createdAtMax?: string;
    updatedAtMin?: string;
    updatedAtMax?: string;
  }): string {
    const conditions: string[] = [];

    if (filters.title) {
      conditions.push(`title:*${filters.title}*`);
    }
    if (filters.vendor) {
      conditions.push(`vendor:'${filters.vendor}'`);
    }
    if (filters.productType) {
      conditions.push(`product_type:'${filters.productType}'`);
    }
    if (filters.tag) {
      conditions.push(`tag:'${filters.tag}'`);
    }
    if (filters.status) {
      conditions.push(`status:${filters.status}`);
    }
    if (filters.sku) {
      conditions.push(`sku:${filters.sku}`);
    }
    if (filters.createdAtMin) {
      conditions.push(`created_at:>=${filters.createdAtMin}`);
    }
    if (filters.createdAtMax) {
      conditions.push(`created_at:<=${filters.createdAtMax}`);
    }
    if (filters.updatedAtMin) {
      conditions.push(`updated_at:>=${filters.updatedAtMin}`);
    }
    if (filters.updatedAtMax) {
      conditions.push(`updated_at:<=${filters.updatedAtMax}`);
    }

    return conditions.join(' AND ');
  }

  /**
   * Build a query string for filtering locations
   */
  static buildLocationQuery(filters: {
    name?: string;
    active?: boolean;
    city?: string;
    province?: string;
    country?: string;
  }): string {
    const conditions: string[] = [];

    if (filters.name) {
      conditions.push(`name:*${filters.name}*`);
    }
    if (filters.active !== undefined) {
      conditions.push(`active:${filters.active}`);
    }
    if (filters.city) {
      conditions.push(`city:'${filters.city}'`);
    }
    if (filters.province) {
      conditions.push(`province:'${filters.province}'`);
    }
    if (filters.country) {
      conditions.push(`country:'${filters.country}'`);
    }

    return conditions.join(' AND ');
  }
} 