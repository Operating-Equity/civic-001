import React, { useState, useEffect } from 'react';
import { ClaimAnalysis, Claim } from '../../types';
import AnalysisResults from './AnalysisResults';
import ServiceLoadingStatus from './ServiceLoadingStatus';
import { AlertTriangle } from 'lucide-react';

interface ClaimEvaluatorProps {
  empiricalClaims: ClaimAnalysis[];
}

const ClaimEvaluator: React.FC<ClaimEvaluatorProps> = ({ empiricalClaims }) => {
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [evaluationStarted, setEvaluationStarted] = useState(false);
  const [currentClaimIndex, setCurrentClaimIndex] = useState(0);
  
  // Results for each service
  const [perplexityResults, setPerplexityResults] = useState<Claim[]>([]);
  const [openAIResults, setOpenAIResults] = useState<Claim[]>([]);
  const [anthropicResults, setAnthropicResults] = useState<Claim[]>([]);
  
  // Service statuses
  const [serviceStatus, setServiceStatus] = useState({
    perplexity: 'idle' as const,
    openai: 'idle' as const,
    anthropic: 'idle' as const
  });
  
  // Error messages
  const [errorMessages, setErrorMessages] = useState({
    perplexity: '',
    openai: '',
    anthropic: ''
  });
  
  // Immediately update results as they come in
  const handleServiceCompletion = (
    modelName: 'perplexity' | 'openai' | 'anthropic',
    result: Claim,
    claimId?: string
  ) => {
    console.log(`[DEBUG] Service ${modelName} completed with result:`, result);
    
    // Immediately update the service status
    setServiceStatus(prev => ({
      ...prev,
      [modelName]: 'success'
    }));
    
    // Add the result to the appropriate array
    if (modelName === 'perplexity') {
      setPerplexityResults(prev => [...prev, { ...result, claimId }]);
    } else if (modelName === 'openai') {
      setOpenAIResults(prev => [...prev, { ...result, claimId }]);
    } else if (modelName === 'anthropic') {
      setAnthropicResults(prev => [...prev, { ...result, claimId }]);
    }
  };
  
  // Function to evaluate a single claim
  const evaluateClaim = async (claim: ClaimAnalysis) => {
    if (!claim) return;
    
    setIsEvaluating(true);
    setServiceStatus({
      perplexity: 'loading',
      openai: 'loading',
      anthropic: 'loading'
    });
    
    try {
      console.log("[DEBUG] Starting evaluation for claim:", claim.claim.substring(0, 50));
      
      // Setup for individual model tracking
      const modelResults: Record<string, any> = {};
      const modelPromises: Promise<void>[] = [];
      
      // Function to process a single model result
      const processModel = async (modelName: 'perplexity' | 'openai' | 'anthropic') => {
        try {
          // Make individual API call for each model to get faster results
          const response = await fetch('/api/analysis/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              claim: claim.claim,
              context: claim.context,
              model: modelName
            })
          });
          
          const data = await response.json();
          console.log(`[DEBUG] ${modelName} API response:`, data);
          
          // Check if we have results for this model
          if (data && data[modelName]) {
            modelResults[modelName] = data[modelName];
            // Immediately update UI with this model's result
            handleServiceCompletion(modelName, data[modelName], claim.id);
          } else {
            throw new Error(`No results returned for ${modelName}`);
          }
        } catch (error) {
          console.error(`Error with ${modelName}:`, error);
          setServiceStatus(prev => ({ ...prev, [modelName]: 'error' }));
          setErrorMessages(prev => ({ 
            ...prev, 
            [modelName]: `Failed to get results from ${modelName.charAt(0).toUpperCase() + modelName.slice(1)}` 
          }));
          
          // Add fallback result
          const fallbackResult = createFallbackResult(claim.claim, modelName);
          if (modelName === 'perplexity') {
            setPerplexityResults(prev => [...prev, { ...fallbackResult, claimId: claim.id }]);
          } else if (modelName === 'openai') {
            setOpenAIResults(prev => [...prev, { ...fallbackResult, claimId: claim.id }]);
          } else if (modelName === 'anthropic') {
            setAnthropicResults(prev => [...prev, { ...fallbackResult, claimId: claim.id }]);
          }
        }
      };
      
      // Start all model evaluations in parallel but handle each independently
      modelPromises.push(processModel('perplexity'));
      modelPromises.push(processModel('openai'));
      modelPromises.push(processModel('anthropic'));
      
      // Wait for all models to complete (but UI will update as each finishes)
      await Promise.all(modelPromises);
      
      console.log("[DEBUG] All models processed:", Object.keys(modelResults));
            
    } catch (error) {
      console.error('Error evaluating claim:', error);
      // This should rarely happen now because each model is handled separately
      setServiceStatus({
        perplexity: 'error',
        openai: 'error',
        anthropic: 'error'
      });
      setErrorMessages({
        perplexity: 'Network error occurred',
        openai: 'Network error occurred',
        anthropic: 'Network error occurred'
      });
    } finally {
      setIsEvaluating(false);
      setCurrentClaimIndex(prev => prev + 1);
    }
  };
  
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
  
  // Start evaluation when claims are provided
  useEffect(() => {
    if (empiricalClaims.length > 0 && !evaluationStarted) {
      setEvaluationStarted(true);
      console.log("[DEBUG] Starting evaluation process with", empiricalClaims.length, "claims");
    }
  }, [empiricalClaims, evaluationStarted]);
  
  // Process claims one by one
  useEffect(() => {
    const processClaims = async () => {
      if (evaluationStarted && !isEvaluating && currentClaimIndex < empiricalClaims.length) {
        console.log("[DEBUG] Processing claim", currentClaimIndex + 1, "of", empiricalClaims.length);
        await evaluateClaim(empiricalClaims[currentClaimIndex]);
      }
    };
    
    processClaims();
  }, [evaluationStarted, isEvaluating, currentClaimIndex, empiricalClaims]);
  
  // Check if all claims have been evaluated
  const allClaimsEvaluated = currentClaimIndex >= empiricalClaims.length;
  
  // Loading state shows until all claims are evaluated
  const loading = evaluationStarted && !allClaimsEvaluated;
  
  // Display error if no claims to evaluate
  if (empiricalClaims.length === 0) {
    return (
      <div className="glass-panel p-6 text-center">
        <AlertTriangle className="h-12 w-12 text-yellow-500 mx-auto mb-4" />
        <h3 className="text-white text-lg font-medium mb-2">No Claims to Evaluate</h3>
        <p className="text-white/70">No empirical claims were found for evaluation.</p>
      </div>
    );
  }

  return (
    <div>
      {/* Show loading status when processing claims */}
      {loading && (
        <div className="glass-panel p-6 mb-6">
          <h2 className="text-xl font-semibold mb-6 text-white flex items-center">
            <AlertTriangle className="mr-2 h-5 w-5 text-primary" />
            Analyzing Claims
          </h2>
          
          <ServiceLoadingStatus 
            perplexityStatus={serviceStatus.perplexity}
            openAIStatus={serviceStatus.openai}
            anthropicStatus={serviceStatus.anthropic}
            errorMessages={errorMessages}
          />
          
          <p className="text-white/70 text-sm mt-6 text-center">
            Processing claim {currentClaimIndex + 1} of {empiricalClaims.length}. This may take a minute.
          </p>
        </div>
      )}
      
      <AnalysisResults
        empiricalClaims={empiricalClaims}
        perplexityResults={perplexityResults}
        openAIResults={openAIResults}
        anthropicResults={anthropicResults}
        isLoading={loading}
        serviceStatus={serviceStatus}
        errorMessages={errorMessages}
      />
      
      {evaluationStarted && allClaimsEvaluated && (
        <div className="mt-4 p-4 bg-green-500/20 border border-green-500/30 rounded-md">
          <p className="text-white text-center">
            All claims have been evaluated! Check the tabs above to see results from each service.
          </p>
        </div>
      )}
    </div>
  );
};

export default ClaimEvaluator;