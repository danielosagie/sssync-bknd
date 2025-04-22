Okay, here's the API documentation for the frontend team explaining how to use the product analysis and generation endpoints.

---

## sssync Backend API Documentation: Product Creation Flow

This document outlines the two primary API endpoints used in the initial product creation flow: analyzing product images and generating listing details using AI.

**Base URL:** `https://api.sssync.app` (Your deployed Railway URL)

**Authentication (Temporary):**
Currently, user identification relies on a `userId` query parameter.
**⚠️ SECURITY WARNING:** This method (`?userId=...`) is **temporary and insecure** for production use. It will be replaced by proper JWT-based authentication soon. Do not rely on this pattern for other features.

---

### Endpoint 1: Analyze Product Images

This endpoint takes product image URLs (which the frontend should upload to Supabase Storage first), analyzes the primary image using a visual search engine (like Google Lens via SerpApi), and returns potential visual matches found online.

*   **Purpose:** Get visual suggestions for the uploaded product image.
*   **Method:** `POST`
*   **URL:** `https://api.sssync.app/products/analyze`
*   **Query Parameters:**
    *   `userId` (string, **required**): The UUID of the authenticated user. *(Temporary - see security warning)*
*   **Request Body:** `application/json`

    ```json
    {
      "imageUris": [
        "https://your-supabase-storage-url.com/image1.jpg",
        "https://your-supabase-storage-url.com/image2.png"
      ],
      "selectedPlatforms": ["shopify", "amazon"]
    }
    ```

    *   `imageUris` (string[], **required**, min 1 item): An array of public URLs for the product images uploaded by the user (e.g., to Supabase Storage). The first URL in the array is typically used for the primary visual analysis.
    *   `selectedPlatforms` (string[], **required**, min 1 item): An array of lowercase platform keys (e.g., "shopify", "amazon", "clover", "square") that the user intends to list on eventually. While not directly used by this endpoint's *analysis*, it might be useful context for future logging or backend logic.

*   **Success Response (200 OK):**
    *   Returns the JSON response directly from the visual search service (SerpApi). The key field to use is `visual_matches`.
    *   **Structure:** See `SerpApiLensResponse` below (simplified).
    *   **Example:**

        ```json
        {
          "search_metadata": {
            "id": "...",
            "status": "Success",
            "google_lens_url": "...",
            "...": "..."
          },
          "visual_matches": [
            {
              "position": 1,
              "title": "Nike Vaporfly 3 Men's Road Racing Shoes. Nike.com",
              "link": "https://www.nike.com/...",
              "source": "Nike",
              "price": {
                "value": "$260*",
                "extracted_value": 260,
                "currency": "$"
              },
              "in_stock": true,
              "thumbnail": "https://encrypted-tbn1.gstatic.com/...",
              "image": "https://static.nike.com/..."
            },
            {
              "position": 2,
              "title": "Amazon.com: Endoto Shoelaces...",
              "link": "https://www.amazon.com/...",
              "source": "Amazon.com",
              "price": { "value": "$9*", "extracted_value": 9, "currency": "$" },
              "in_stock": true,
              "thumbnail": "https://encrypted-tbn3.gstatic.com/...",
              "image": "https://m.media-amazon.com/..."
            }
            // ... more matches
          ]
          // Potentially other fields like "related_content", "products" might exist
        }
        ```

    *   **If analysis fails or returns no results:** The endpoint might return a 200 OK with a specific message body:
        ```json
        {
          "message": "Image analysis failed or returned no results."
        }
        ```

*   **Error Responses:**
    *   `400 Bad Request`: Input validation failed (e.g., missing `imageUris`, invalid URLs, missing `userId`). The response body often contains a `message` field detailing the error(s).
        ```json
        {
          "message": [
            "imageUris should not be empty",
            "imageUris must contain at least 1 elements",
            "each value in imageUris must be a URL address"
          ],
          "error": "Bad Request",
          "statusCode": 400
        }
        ```
        ```json
        {
          "message": "Temporary: userId query parameter is required.",
          "error": "Bad Request",
          "statusCode": 400
        }
        ```
    *   `500 Internal Server Error`: An unexpected error occurred on the backend (e.g., visual search API key missing or invalid, external API down).
        ```json
        {
          "message": "Internal Server Error",
          "statusCode": 500
        }
        ```

---

### Endpoint 2: Generate Product Details (AI)

This endpoint takes the product image URLs, identifies the cover image, specifies target platforms, and optionally includes the visual search results from Endpoint 1. It uses an AI model (Groq Maverick) to generate draft listing details (title, description, price, etc.) tailored for the selected platforms and saves a draft product in the database.

*   **Purpose:** Generate draft listing content using AI based on images and optional context.
*   **Method:** `POST`
*   **URL:** `https://api.sssync.app/products/generate-details`
*   **Query Parameters:**
    *   `userId` (string, **required**): The UUID of the authenticated user. *(Temporary - see security warning)*
*   **Request Body:** `application/json`

    ```json
    {
      "imageUris": [
        "https://your-supabase-storage-url.com/cover.jpg",
        "https://your-supabase-storage-url.com/angle2.png"
      ],
      "coverImageIndex": 0,
      "selectedPlatforms": ["shopify", "amazon"],
      "lensResponse": { // Optional: Include the *full* JSON response from Endpoint 1
        "search_metadata": { "...": "..." },
        "visual_matches": [
            { "position": 1, "title": "Match 1...", "...": "..." },
            { "position": 2, "title": "Match 2...", "...": "..." }
        ]
        // ... other fields from SerpApi response ...
      }
    }
    ```

    *   `imageUris` (string[], **required**, min 1 item): Same array of public image URLs as sent to Endpoint 1.
    *   `coverImageIndex` (number, **required**, >= 0): The index within the `imageUris` array corresponding to the primary image the user wants the AI to focus on. Must be a valid index for the array.
    *   `selectedPlatforms` (string[], **required**, min 1 item): Array of lowercase platform keys for which details should be generated.
    *   `lensResponse` (object, *optional*): The **entire JSON object** received as the success response from Endpoint 1 (`/products/analyze`). Providing this gives the AI valuable context (visual matches, pricing hints) for better generation. If Endpoint 1 failed or returned no results, omit this field or send `null`.

*   **Success Response (200 OK):** (Note: While creating a draft, 201 might be more semantic, but 200 is currently implemented)
    *   Returns the newly created draft product/variant IDs and the AI-generated details structured by platform.
    *   **Structure:**

        ```json
        {
          "productId": "a1b2c3d4-...", // UUID of the created Product record
          "variantId": "e5f6g7h8-...", // UUID of the created ProductVariant record
          "generatedDetails": { // The AI's attempt to generate details
            "shopify": { // Key matches requested platform
              "title": "High-Performance Nike Vaporfly 3 Running Shoe",
              "description": "Experience peak performance with the Nike Vaporfly 3...",
              "price": 255, // Estimated price (number)
              "category": "Running Shoes",
              "tags": ["nike", "vaporfly", "running", "performance", "racing"],
              "weight": 0.4, // Estimated weight (number)
              "weightUnit": "kg"
              // ... other generated fields ...
            },
            "amazon": { // Key matches requested platform
              "title": "Nike Men's Vaporfly 3 Road Racing Shoes - Latest Model",
              "description": "Push your limits with the lightweight and responsive Nike Vaporfly 3...",
              "price": 258,
              "category": "Sports & Outdoors > Running Shoes",
              "bullet_points": [
                "Advanced ZoomX foam for maximum energy return.",
                "Carbon fiber plate for propulsion.",
                "Breathable upper for comfort."
              ],
              "search_terms": ["nike running shoes", "vaporfly 3", "marathon shoes", "carbon plate"],
              "weight": 0.4,
              "weightUnit": "kg"
              // ... other generated fields ...
            }
            // ... other requested platforms ...
          }
        }
        ```
    *   **Note:** The structure and quality of `generatedDetails` depend entirely on the AI model's output for the given prompt and inputs. It might occasionally miss platforms, hallucinate fields, or need user correction. The frontend should treat this as a starting point for the listing form.

*   **Error Responses:**
    *   `400 Bad Request`: Input validation failed (missing fields, invalid index, etc.) OR the AI generation was blocked by safety filters.
        ```json
        {
          "message": "coverImageIndex is out of bounds for the provided imageUris array.",
          "error": "Bad Request",
          "statusCode": 400
        }
        ```
         ```json
        {
          "message": "Content generation blocked by safety filters: HARM_CATEGORY_...",
          "error": "Bad Request",
          "statusCode": 400
        }
        ```
    *   `500 Internal Server Error`: An unexpected error occurred (e.g., AI API key invalid, external API down, database error during draft creation, AI failed to generate valid JSON).
        ```json
        {
          "message": "AI content generation failed: Groq API multimodal request failed: ...", // More specific error message might be included
          "statusCode": 500
        }
        ```
        ```json
        {
          "message": "Failed to save draft product.",
          "statusCode": 500
        }
        ```

---

### Frontend Workflow Summary

1.  **Collect Inputs:** User selects target platforms and uploads/selects images (including designating a cover photo). Frontend uploads images to storage (e.g., Supabase Storage) and gets public URLs.
2.  **Call Analyze API:** Frontend sends `POST /products/analyze` request with image URLs, selected platforms, and `userId`.
3.  **Display Suggestions (Optional):** Frontend receives the `SerpApiLensResponse`. If `visual_matches` exist, display them as selectable suggestion cards. User can select one or choose to skip/use their images only.
4.  **Call Generate Details API:** Frontend sends `POST /products/generate-details` request with image URLs, `coverImageIndex`, selected platforms, `userId`, and optionally the full `lensResponse` object from step 2/3.
5.  **Populate Form:** Frontend receives the `productId`, `variantId`, and `generatedDetails`. Use this data to populate the main listing form fields and the platform-specific sections. Allow the user to edit all generated fields. Store the `productId` and `variantId` for the next step.
6.  **Save/Publish (Future Endpoints):** When the user finalizes edits:
    *   **(Save Draft - TODO):** Call a future endpoint like `PATCH /products/variants/{variantId}` with the final edited form data.
    *   **(Publish - TODO):** Call a future endpoint like `POST /products/variants/{variantId}/publish` to initiate listing on the selected platforms.

---
