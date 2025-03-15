import { useState, useCallback, useEffect, useRef } from 'react';
import { 
  ClaimAnalysis, 
  Claim,
  VideoAnalysisResult,
  ServiceStatus,
  SpeakersData
} from '../types';
import { 
  processVideoUrl, 
  processVideoFile,
  evaluateClaim,
  evaluateMultipleClaims
} from '../services/api';

// Define processing stages for tracking progress
export type ProcessingStage = 'idle' | 'extracting_transcript' | 'identifying_speakers' | 'extracting_claims' | 'verifying_claims' | 'complete';

export const useVideoAnalysis = () => {
  // Refs for scrolling
  const scrollPositionRef = useRef(0);
  
  const [transcript, setTranscript] = useState('');
  const [thumbnailUrl, setThumbnailUrl] = useState('');
  const [summary, setSummary] = useState('');
  const [videoTitle, setVideoTitle] = useState('');
  const [speakersData, setSpeakersData] = useState<SpeakersData | null>(null);
  
  const [empiricalClaims, setEmpiricalClaims] = useState<ClaimAnalysis[]>([]);
  const [perplexityResults, setPerplexityResults] = useState<Claim[]>([]);
  const [openAIResults, setOpenAIResults] = useState<Claim[]>([]);
  const [anthropicResults, setAnthropicResults] = useState<Claim[]>([]);
  
  // Single loading state to prevent duplicate loading indicators
  const [isLoading, setIsLoading] = useState(false);
  
  // Added new state to track the current processing stage
  const [processingStage, setProcessingStage] = useState<ProcessingStage>('idle');
  
  // Track loading state for each service
  const [serviceStatus, setServiceStatus] = useState({
    perplexity: 'idle' as ServiceStatus,
    openai: 'idle' as ServiceStatus,
    anthropic: 'idle' as ServiceStatus
  });
  
  // Track error messages for each service
  const [errorMessages, setErrorMessages] = useState({
    perplexity: '',
    openai: '',
    anthropic: ''
  });
  
  const [error, setError] = useState<string | null>(null);
  const [processingClaimIndex, setProcessingClaimIndex] = useState(-1);
  
  // Function to save scroll position
  const saveScrollPosition = useCallback(() => {
    scrollPositionRef.current = window.scrollY;
  }, []);
  
  // Function to restore scroll position
  const restoreScrollPosition = useCallback(() => {
    window.scrollTo(0, scrollPositionRef.current);
  }, []);
  
  const resetStates = useCallback(() => {
    setTranscript('');
    setThumbnailUrl('');
    setSummary('');
    setVideoTitle('');
    setEmpiricalClaims([]);
    setPerplexityResults([]);
    setOpenAIResults([]);
    setAnthropicResults([]);
    setSpeakersData(null);
    setError(null);
    setServiceStatus({
      perplexity: 'idle',
      openai: 'idle',
      anthropic: 'idle'
    });
    setErrorMessages({
      perplexity: '',
      openai: '',
      anthropic: ''
    });
    setProcessingClaimIndex(-1);
    setProcessingStage('idle');
  }, []);
  
  const handleVideoSubmit = useCallback(async (input: { type: 'file' | 'url'; value: File | string; with_speakers?: boolean }) => {
    // Save scroll position before state updates
    saveScrollPosition();
    
    // Reset loading state to ensure only one loading indicator
    setIsLoading(true);
    setError(null);
    resetStates();
    
    // Set initial processing stage
    setProcessingStage('extracting_transcript');
    
    try {
      let result: VideoAnalysisResult;
      
      if (input.type === 'url') {
        result = await processVideoUrl(input.value as string, input.with_speakers);
      } else {
        result = await processVideoFile(input.value as File, input.with_speakers);
      }
      
      // Set the basic video analysis results
      setTranscript(result.transcript);
      setSummary(result.summary);
      setEmpiricalClaims(result.empiricalClaims);
      setVideoTitle(result.videoTitle);
      
      if (result.thumbnailUrl) {
        setThumbnailUrl(result.thumbnailUrl);
      }
      
      // Update stage for speaker identification if available
      if (input.with_speakers) {
        setProcessingStage('identifying_speakers');
      }
      
      if (result.speakers_data) {
        setSpeakersData(result.speakers_data);
      }
      
      // Update stage for claim extraction
      setProcessingStage('extracting_claims');
      
      // Process claims with AI models
      if (result.empiricalClaims.length > 0) {
        // Update stage before processing claims
        setProcessingStage('verifying_claims');
        
        processClaims(result.empiricalClaims, result.summary);
      } else {
        // If no claims to process, set loading to false
        setProcessingStage('complete');
        setIsLoading(false);
      }
      
      // Restore scroll position after state updates
      setTimeout(restoreScrollPosition, 100);
      
    } catch (error: any) {
      setError(error.message || 'Failed to process video');
      console.error('Error processing video:', error);
      setIsLoading(false); // Make sure to set loading to false on error
      setProcessingStage('idle');
    }
  }, [resetStates, saveScrollPosition, restoreScrollPosition]);

  // Enhanced parallel processing of all claims at once
  const processClaims = useCallback(async (claims: ClaimAnalysis[], summary: string) => {
    if (!claims.length) {
      setIsLoading(false); // Set loading to false if no claims
      setProcessingStage('complete');
      return;
    }
    
    // Set initial loading state for all services
    setServiceStatus({
      perplexity: 'loading',
      openai: 'loading',
      anthropic: 'loading'
    });
    
    try {
      // Create context combining summary and specific claim contexts
      const globalContext = `Video Summary: ${summary}`;
      
      // Format claims for the batch API
      const formattedClaims = claims.map(claim => ({
        id: claim.id,
        claim: claim.claim,
        context: claim.context
      }));
      
      console.log(`[DEBUG] Processing ${claims.length} claims in parallel`);
      setProcessingClaimIndex(0); // Start with the first claim
      
      // Set up a timer to update the processing claim index to simulate progress
      // This doesn't reflect actual processing order but gives visual feedback
      let progressCounter = 0;
      const progressTimer = setInterval(() => {
        if (progressCounter < claims.length - 1) {
          progressCounter++;
          setProcessingClaimIndex(progressCounter);
        } else {
          clearInterval(progressTimer);
        }
      }, 1500); // Update every 1.5 seconds
      
      // Call the batch API to process all claims at once in parallel
      const results = await evaluateMultipleClaims(formattedClaims, globalContext);
      
      // Clear the progress timer
      clearInterval(progressTimer);
      
      console.log('[DEBUG] Batch processing complete, processing results');
      setProcessingClaimIndex(claims.length - 1); // All claims processed
      
      // Process results for each claim and model
      if (results && typeof results === 'object') {
        const perplexityResultsList: Claim[] = [];
        const openAIResultsList: Claim[] = [];
        const anthropicResultsList: Claim[] = [];
        
        // Track which models succeeded
        const successfulModels = {
          perplexity: false,
          openai: false,
          anthropic: false
        };
        
        // Process each claim's results
        let claimIndex = 0;
        for (const [claimId, claimResults] of Object.entries(results)) {
          // Update current claim index for UI display
          claimIndex++;
          
          if (claimResults.perplexity) {
            perplexityResultsList.push({
              ...claimResults.perplexity,
              claimId
            });
            successfulModels.perplexity = true;
          }
          
          if (claimResults.openai) {
            openAIResultsList.push({
              ...claimResults.openai,
              claimId
            });
            successfulModels.openai = true;
          }
          
          if (claimResults.anthropic) {
            anthropicResultsList.push({
              ...claimResults.anthropic,
              claimId
            });
            successfulModels.anthropic = true;
          }
        }
        
        // Update results for each model
        setPerplexityResults(perplexityResultsList);
        setOpenAIResults(openAIResultsList);
        setAnthropicResults(anthropicResultsList);
        
        // Update service statuses
        setServiceStatus({
          perplexity: successfulModels.perplexity ? 'success' : 'error',
          openai: successfulModels.openai ? 'success' : 'error',
          anthropic: successfulModels.anthropic ? 'success' : 'error'
        });
        
        // Save scroll position as state is updated
        saveScrollPosition();
      } else {
        throw new Error('Invalid response format from claim evaluation');
      }
    } catch (error: any) {
      console.error('Error processing claims in parallel:', error);
      
      // Create fallback results for all services
      const fallbackResults = claims.map(claim => {
        const fallbackClaim = createFallbackResult(claim.claim, 'error');
        return {
          ...fallbackClaim,
          claimId: claim.id
        };
      });
      
      // Update with fallback results
      setPerplexityResults(fallbackResults.map(result => ({ ...result, model: 'Perplexity' })));
      setOpenAIResults(fallbackResults.map(result => ({ ...result, model: 'OpenAI' })));
      setAnthropicResults(fallbackResults.map(result => ({ ...result, model: 'Anthropic' })));
      
      // Update all services to error state
      setServiceStatus({
        perplexity: 'error',
        openai: 'error',
        anthropic: 'error'
      });
      
      setErrorMessages({
        perplexity: 'Failed to process claims',
        openai: 'Failed to process claims',
        anthropic: 'Failed to process claims'
      });
    } finally {
      // Set loading to false when all processing is complete
      setIsLoading(false);
      setProcessingClaimIndex(-1);
      setProcessingStage('complete');
      
      // Restore scroll position
      setTimeout(restoreScrollPosition, 100);
    }
  }, [saveScrollPosition, restoreScrollPosition]);
  
  // Helper function to create a fallback result when a model fails
  const createFallbackResult = (claim: string, errorSource: string): Claim => {
    return {
      statement: claim,
      classification: 'UNVERIFIED',
      confidence: 0,
      supportingFacts: `Error: Could not evaluate claim with ${errorSource}`,
      error: `Failed to get evaluation from ${errorSource}`,
      model: errorSource.charAt(0).toUpperCase() + errorSource.slice(1)
    };
  };
  
  // Effect to handle scroll position management when new content appears
  useEffect(() => {
    // Restore scroll position when components render
    restoreScrollPosition();
    
    // Clean up event listeners when component unmounts
    return () => {
      // Nothing to clean up since we're not using event listeners directly
    };
  }, [restoreScrollPosition, empiricalClaims.length, perplexityResults.length]);
  
  return {
    // State
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    perplexityResults,
    openAIResults,
    anthropicResults,
    speakersData,
    isLoading,
    error,
    serviceStatus,
    errorMessages,
    processingClaimIndex,
    processingStage,
    
    // Actions
    handleVideoSubmit,
    resetStates
  };
};