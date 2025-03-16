import { useState, useCallback, useEffect, useRef } from 'react';
import { ClaimAnalysis, KeywordResult, ClaimSearchResults, SearchResult } from '../types';
import { 
  generateKeywords, 
  searchEvidence, 
  generateKeywordsBatch,
  searchEvidenceBatch,
  searchEvidenceForClaim,
  searchEvidenceForClaims
} from '../services/api';

/**
 * Enhanced hook for evidence search functionality
 * Provides improved search capabilities with better error handling and timebound detection
 */
export const useEvidenceSearch = (
  claims: ClaimAnalysis[],
  videoTitle?: string
) => {
  const [keywordResults, setKeywordResults] = useState<KeywordResult[]>([]);
  const [searchResults, setSearchResults] = useState<ClaimSearchResults[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchStats, setSearchStats] = useState<{
    totalResults: number;
    timeboundClaims: number;
    lastSearched: Date | null;
  }>({
    totalResults: 0,
    timeboundClaims: 0,
    lastSearched: null
  });
  
  // Ref to track currently processing requests
  const activeRequestsRef = useRef<{[key: string]: AbortController}>({});
  
  // Cleanup function for aborting active requests
  useEffect(() => {
    return () => {
      // Abort any active requests when component unmounts
      Object.values(activeRequestsRef.current).forEach(controller => {
        controller.abort();
      });
    };
  }, []);
  
  /**
   * Detect if a claim is about a recent or timebound event
   */
  const isTimeboundClaim = useCallback((claim: string): boolean => {
    if (!claim) return false;
    
    // Search for temporal indicators
    const timeIndicators = [
      /\b(today|yesterday|last\s+week|this\s+week|this\s+month|this\s+year)\b/i,
      /\b(recent(ly)?|latest|current|now|just|new)\b/i,
      /\b(202[3-5])\b/i, // Recent years (2023-2025)
      /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+202[3-5]\b/i // Month + recent year
    ];
    
    return timeIndicators.some(pattern => pattern.test(claim));
  }, []);
  
  /**
   * Generate keywords for claims in parallel with improved error handling
   */
  const generateKeywordsForClaims = useCallback(async () => {
    if (!claims.length) return;
    
    setIsGenerating(true);
    setError(null);
    
    try {
      // Create abort controller for this request
      const controller = new AbortController();
      const requestId = 'generate-keywords-batch';
      activeRequestsRef.current[requestId] = controller;
      
      // Use batch API to generate keywords for all claims in parallel
      const results = await generateKeywordsBatch(claims, videoTitle || '', { signal: controller.signal });
      
      // Remove from active requests
      delete activeRequestsRef.current[requestId];
      
      setKeywordResults(results);
      
      // Count timebound claims
      const timeboundClaimCount = claims.filter(claim => isTimeboundClaim(claim.claim)).length;
      setSearchStats(prev => ({
        ...prev,
        timeboundClaims: timeboundClaimCount
      }));
      
    } catch (error: any) {
      // Don't set error if request was aborted
      if (error.name !== 'AbortError') {
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
      }
    } finally {
      setIsGenerating(false);
    }
  }, [claims, videoTitle, isTimeboundClaim]);
  
  // Effect to generate keywords when claims change
  useEffect(() => {
    if (claims.length > 0) {
      generateKeywordsForClaims();
    }
  }, [claims, generateKeywordsForClaims]);
  
  /**
   * Enhanced search for evidence with timebound claim detection
   * @param claim The claim text 
   * @param keywords Search keywords to use
   */
  const searchForEvidence = useCallback(async (claim: string, keywords: string[]) => {
    if (!keywords.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      // Create abort controller for this request
      const controller = new AbortController();
      const requestId = `search-${claim.substring(0, 20)}`;
      activeRequestsRef.current[requestId] = controller;
      
      // Detect if this is a timebound claim
      const isTimebound = isTimeboundClaim(claim);
      
      // For timebound claims, use the specialized endpoint
      if (isTimebound) {
        console.log(`Detected timebound claim: ${claim.substring(0, 30)}...`);
        try {
          // Use the specialized search for timebound claims
          const result = await searchEvidenceForClaim(
            { claim, context: '', validationPotential: '' },
            videoTitle || '',
            { signal: controller.signal, detect_timebound: true }
          );
          
          // Check if we already have search results for this claim
          const existingResultIndex = searchResults.findIndex(r => r.claim === claim);
          
          if (existingResultIndex >= 0) {
            // Update existing results
            const updatedResults = [...searchResults];
            updatedResults[existingResultIndex] = result;
            setSearchResults(updatedResults);
          } else {
            // Add new results
            setSearchResults(prev => [...prev, result]);
          }
          
          // Update stats
          setSearchStats(prev => ({
            ...prev,
            totalResults: countTotalResults([...searchResults.filter(r => r.claim !== claim), result]),
            lastSearched: new Date()
          }));
          
        } catch (error) {
          console.error('Error with timebound search, falling back to regular search:', error);
          // Fall back to regular search if timebound search fails
          await performRegularSearch(claim, keywords, controller.signal);
        }
      } else {
        // Regular search for non-timebound claims
        await performRegularSearch(claim, keywords, controller.signal);
      }
      
      // Remove from active requests
      delete activeRequestsRef.current[requestId];
      
      // Scroll to the evidence section when results are loaded
      setTimeout(() => {
        const evidenceSection = document.getElementById('evidence-section');
        if (evidenceSection) {
          evidenceSection.scrollIntoView({ behavior: 'smooth' });
        }
      }, 100);
      
    } catch (error: any) {
      // Don't set error if request was aborted
      if (error.name !== 'AbortError') {
        setError(error.message || 'Failed to search for evidence');
        console.error('Error searching for evidence:', error);
      }
    } finally {
      setIsSearching(false);
    }
  }, [searchResults, isTimeboundClaim, videoTitle]);
  
  /**
   * Helper function to perform a regular (non-timebound) search
   */
  const performRegularSearch = async (claim: string, keywords: string[], signal?: AbortSignal) => {
    try {
      // Use batch search to process all keywords in parallel
      const allResults = await searchEvidenceBatch(keywords, claim, { signal });
      
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
      
      // Update stats
      const updatedResults = [...searchResults];
      if (existingResultIndex >= 0) {
        updatedResults[existingResultIndex] = { claim, keywordResults };
      } else {
        updatedResults.push({ claim, keywordResults });
      }
      
      setSearchStats(prev => ({
        ...prev,
        totalResults: countTotalResults(updatedResults),
        lastSearched: new Date()
      }));
      
    } catch (error: any) {
      // Rethrow for the main function to handle
      throw error;
    }
  };
  
  /**
   * Search for a single claim with optimized processing
   */
  const searchForClaimEvidence = useCallback(async (claim: ClaimAnalysis) => {
    setIsSearching(true);
    setError(null);
    
    try {
      // Create abort controller for this request
      const controller = new AbortController();
      const requestId = `search-claim-${claim.id || claim.claim.substring(0, 20)}`;
      activeRequestsRef.current[requestId] = controller;
      
      // Detect if this is a timebound claim
      const isTimebound = isTimeboundClaim(claim.claim);
      
      // Use the optimized endpoint that handles keyword generation and searching
      const result = await searchEvidenceForClaim(
        claim, 
        videoTitle || '', 
        { 
          signal: controller.signal,
          detect_timebound: isTimebound
        }
      );
      
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
      
      // Update stats
      setSearchStats(prev => ({
        ...prev,
        totalResults: countTotalResults([...searchResults.filter(r => r.claim !== claim.claim), result]),
        lastSearched: new Date()
      }));
      
      // Remove from active requests
      delete activeRequestsRef.current[requestId];
      
    } catch (error: any) {
      // Don't set error if request was aborted
      if (error.name !== 'AbortError') {
        setError(error.message || 'Failed to search for evidence');
        console.error('Error searching for claim evidence:', error);
      }
    } finally {
      setIsSearching(false);
    }
  }, [searchResults, videoTitle, isTimeboundClaim]);
  
  /**
   * Search all claims with their keywords in parallel
   */
  const searchAllClaims = useCallback(async () => {
    if (!claims.length) return;
    
    setIsSearching(true);
    setError(null);
    
    try {
      // Create abort controller for this request
      const controller = new AbortController();
      const requestId = 'search-all-claims';
      activeRequestsRef.current[requestId] = controller;
      
      // Count timebound claims for stats
      const timeboundClaimCount = claims.filter(claim => isTimeboundClaim(claim.claim)).length;
      
      // Use the batch endpoint to process all claims in parallel
      const results = await searchEvidenceForClaims(
        claims, 
        videoTitle || '', 
        { 
          signal: controller.signal,
          detect_timebound: true  // Enable timebound detection
        }
      );
      
      setSearchResults(results);
      
      // Update stats
      setSearchStats({
        totalResults: countTotalResults(results),
        timeboundClaims: timeboundClaimCount,
        lastSearched: new Date()
      });
      
      // Remove from active requests
      delete activeRequestsRef.current[requestId];
      
    } catch (error: any) {
      // Don't set error if request was aborted
      if (error.name !== 'AbortError') {
        setError(error.message || 'Failed to search all claims');
        console.error('Error searching all claims:', error);
        
        // Fallback: try to search for each claim individually
        try {
          const allResults: ClaimSearchResults[] = [];
          
          for (const keywordResult of keywordResults) {
            const claim = claims.find(c => c.claim === keywordResult.claim);
            if (claim) {
              try {
                const result = await searchEvidenceForClaim(
                  claim, 
                  videoTitle || '', 
                  { detect_timebound: isTimeboundClaim(claim.claim) }
                );
                allResults.push(result);
              } catch (error) {
                console.error('Error searching for individual claim:', claim.claim, error);
              }
            }
          }
          
          if (allResults.length > 0) {
            setSearchResults(allResults);
            
            // Update stats
            setSearchStats({
              totalResults: countTotalResults(allResults),
              timeboundClaims: claims.filter(claim => isTimeboundClaim(claim.claim)).length,
              lastSearched: new Date()
            });
          }
        } catch (fallbackError) {
          console.error('Fallback claim search also failed:', fallbackError);
        }
      }
    } finally {
      setIsSearching(false);
    }
  }, [claims, keywordResults, videoTitle, isTimeboundClaim]);
  
  /**
   * Cancel all active search requests
   */
  const cancelSearches = useCallback(() => {
    Object.values(activeRequestsRef.current).forEach(controller => {
      controller.abort();
    });
    activeRequestsRef.current = {};
    setIsSearching(false);
  }, []);
  
  /**
   * Helper function to count total results across all claims and keywords
   */
  const countTotalResults = (results: ClaimSearchResults[]): number => {
    return results.reduce((total, claim) => {
      return total + claim.keywordResults.reduce((keywordTotal, keyword) => {
        return keywordTotal + keyword.results.length;
      }, 0);
    }, 0);
  };
  
  return {
    keywordResults,
    searchResults,
    isGenerating,
    isSearching,
    error,
    searchStats,
    generateKeywordsForClaims,
    searchForEvidence,
    searchForClaimEvidence,
    searchAllClaims,
    cancelSearches,
    isTimeboundClaim
  };
};