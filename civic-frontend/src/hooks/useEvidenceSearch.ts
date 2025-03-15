import { useState, useCallback, useEffect } from 'react';
import { ClaimAnalysis, KeywordResult, ClaimSearchResults, SearchResult } from '../types';
import { 
  generateKeywords, 
  searchEvidence, 
  generateKeywordsBatch,
  searchEvidenceBatch,
  searchEvidenceForClaim,
  searchEvidenceForClaims
} from '../services/api';

export const useEvidenceSearch = (
  claims: ClaimAnalysis[],
  videoTitle?: string
) => {
  const [keywordResults, setKeywordResults] = useState<KeywordResult[]>([]);
  const [searchResults, setSearchResults] = useState<ClaimSearchResults[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Generate keywords for claims in parallel
  const generateKeywordsForClaims = useCallback(async () => {
    if (!claims.length) return;
    
    setIsGenerating(true);
    setError(null);
    
    try {
      // Use batch API to generate keywords for all claims in parallel
      const results = await generateKeywordsBatch(claims, videoTitle || '');
      setKeywordResults(results);
    } catch (error: any) {
      setError(error.message || 'Failed to generate keywords');
      console.error('Error generating keywords:', error);
      
      // Fallback: try to generate keywords one by one
      try {
        const results: KeywordResult[] = [];
        
        for (const claim of claims) {
          try {
            const searchQueries = await generateKeywords(
              claim.claim,
              claim.context,
              claim.validationPotential,
              videoTitle || ''
            );
            
            results.push({
              claim: claim.claim,
              searchQueries
            });
          } catch (error) {
            console.error('Error generating keywords for claim:', claim.claim, error);
          }
        }
        
        setKeywordResults(results);
      } catch (fallbackError) {
        console.error('Fallback keyword generation also failed:', fallbackError);
      }
    } finally {
      setIsGenerating(false);
    }
  }, [claims, videoTitle]);
  
  // Effect to generate keywords when claims change
  useEffect(() => {
    if (claims.length > 0) {
      generateKeywordsForClaims();
    }
  }, [claims, generateKeywordsForClaims]);
  
  // Search for evidence using generated keywords - optimized version
  const searchForEvidence = useCallback(async (claim: string, keywords: string[]) => {
    if (!keywords.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      // Use batch search to process all keywords in parallel
      const allResults = await searchEvidenceBatch(keywords);
      
      // Format the results
      const keywordResults = keywords.map((keyword, index) => ({
        keyword,
        results: allResults[index] || []
      }));
      
      // Check if we already have search results for this claim
      const existingResultIndex = searchResults.findIndex(r => r.claim === claim);
      
      if (existingResultIndex >= 0) {
        // Update existing results
        const updatedResults = [...searchResults];
        updatedResults[existingResultIndex] = {
          claim,
          keywordResults
        };
        setSearchResults(updatedResults);
      } else {
        // Add new results
        setSearchResults(prev => [
          ...prev,
          {
            claim,
            keywordResults
          }
        ]);
      }
      
      // Scroll to the evidence section when results are loaded
      setTimeout(() => {
        const evidenceSection = document.getElementById('evidence-section');
        if (evidenceSection) {
          evidenceSection.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
      
    } catch (error: any) {
      setError(error.message || 'Failed to search for evidence');
      console.error('Error searching for evidence:', error);
      
      // Fallback to individual searches
      try {
        const keywordResults: { keyword: string; results: SearchResult[] }[] = [];
        
        for (const keyword of keywords) {
          try {
            const results = await searchEvidence(keyword);
            keywordResults.push({
              keyword,
              results
            });
          } catch (error) {
            console.error('Error searching for keyword:', keyword, error);
            keywordResults.push({
              keyword,
              results: []
            });
          }
        }
        
        // Update results
        const existingResultIndex = searchResults.findIndex(r => r.claim === claim);
        
        if (existingResultIndex >= 0) {
          const updatedResults = [...searchResults];
          updatedResults[existingResultIndex] = {
            claim,
            keywordResults
          };
          setSearchResults(updatedResults);
        } else {
          setSearchResults(prev => [
            ...prev,
            {
              claim,
              keywordResults
            }
          ]);
        }
      } catch (fallbackError) {
        console.error('Fallback search also failed:', fallbackError);
      }
    } finally {
      setIsSearching(false);
    }
  }, [searchResults]);
  
  // Search for a single claim with all processing in one request
  const searchForClaimEvidence = useCallback(async (claim: ClaimAnalysis) => {
    setIsSearching(true);
    setError(null);
    
    try {
      // Use the optimized endpoint that handles keyword generation and searching
      const result = await searchEvidenceForClaim(claim, videoTitle || '');
      
      // Check if we already have search results for this claim
      const existingResultIndex = searchResults.findIndex(r => r.claim === claim.claim);
      
      if (existingResultIndex >= 0) {
        // Update existing results
        const updatedResults = [...searchResults];
        updatedResults[existingResultIndex] = result;
        setSearchResults(updatedResults);
      } else {
        // Add new results
        setSearchResults(prev => [...prev, result]);
      }
    } catch (error: any) {
      setError(error.message || 'Failed to search for evidence');
      console.error('Error searching for claim evidence:', error);
    } finally {
      setIsSearching(false);
    }
  }, [searchResults, videoTitle]);
  
  // Search all claims with their keywords in parallel
  const searchAllClaims = useCallback(async () => {
    if (!claims.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      // Use the batch endpoint to process all claims in parallel
      const results = await searchEvidenceForClaims(claims, videoTitle || '');
      setSearchResults(results);
    } catch (error: any) {
      setError(error.message || 'Failed to search all claims');
      console.error('Error searching all claims:', error);
      
      // Fallback: try to search for each claim individually
      try {
        const allResults: ClaimSearchResults[] = [];
        
        for (const keywordResult of keywordResults) {
          const claim = claims.find(c => c.claim === keywordResult.claim);
          if (claim) {
            try {
              const result = await searchEvidenceForClaim(claim, videoTitle || '');
              allResults.push(result);
            } catch (error) {
              console.error('Error searching for individual claim:', claim.claim, error);
            }
          }
        }
        
        if (allResults.length > 0) {
          setSearchResults(allResults);
        }
      } catch (fallbackError) {
        console.error('Fallback claim search also failed:', fallbackError);
      }
    } finally {
      setIsSearching(false);
    }
  }, [claims, keywordResults, videoTitle]);
  
  return {
    keywordResults,
    searchResults,
    isGenerating,
    isSearching,
    error,
    generateKeywordsForClaims,
    searchForEvidence,
    searchForClaimEvidence,
    searchAllClaims
  };
};