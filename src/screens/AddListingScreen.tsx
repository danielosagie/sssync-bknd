import React, { useState } from 'react';
import { Alert } from 'react-native';

const AddListingScreen = () => {
  const [isLoading, setIsLoading] = useState(false);
  const [loadingMessage, setLoadingMessage] = useState('');

  const handlePublish = async () => {
    setIsLoading(true);
    setLoadingMessage('Publishing...');

    try {
      // ... existing code ...

      if (shopifyConnection && shopifyConnection.Id) {
        if (shopifyConnection.Status !== 'active' && shopifyConnection.Status !== 'connected') {
          Alert.alert(
            "Shopify Connection Requires Attention",
            `Your Shopify store connection (${shopifyConnection.DisplayName || 'Shopify'}) currently has a status of '${shopifyConnection.Status}'. Please ensure it is fully active (you might need to re-authenticate or complete setup steps in your profile) before publishing or managing Shopify-specific details.`
          );
          setIsLoading(false);
          setLoadingMessage('');
          return;
        }

        console.log("[handlePublish] Found Shopify connection ID:", shopifyConnection.Id);
      }

      // ... existing code ...
    } catch (error) {
      console.error("Error in handlePublish:", error);
      setIsLoading(false);
      setLoadingMessage('Failed to publish');
    }
  };

  return (
    // ... rest of the component code ...
  );
};

export default AddListingScreen; 