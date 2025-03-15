import React, { useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, BarChart4, FileText, Shield } from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';
import FactCheckCard from './FactCheckCard';
import ModelComparison from './ModelComparison';
import ServiceLoadingStatus, { ServiceStatus } from './ServiceLoadingStatus';

interface AnalysisResultsProps {
  empiricalClaims: ClaimAnalysis[];
  perplexityResults: Claim[];
  openAIResults: Claim[];
  anthropicResults: Claim[];
  isLoading?: boolean;
  serviceStatus?: {
    perplexity: ServiceStatus;
    openai: ServiceStatus;
    anthropic: ServiceStatus;
  };
  errorMessages?: {
    perplexity?: string;
    openai?: string;
    anthropic?: string;
  };
}

type TabType = 'claims' | 'perplexity' | 'openai' | 'anthropic' | 'comparison';

const AnalysisResults: React.FC<AnalysisResultsProps> = ({
  empiricalClaims,
  perplexityResults,
  openAIResults,
  anthropicResults,
  isLoading = false,
  serviceStatus = {
    perplexity: 'idle',
    openai: 'idle',
    anthropic: 'idle'
  },
  errorMessages = {}
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('claims');
  
  if (isLoading) {
    return (
      <div className="glass-panel p-6 min-h-[300px]">
        <div className="mb-6">
          <div className="flex items-center space-x-2 mb-3">
            <div className="p-1.5 bg-primary/10 rounded-md">
              <Shield className="h-5 w-5 text-primary" />
            </div>
            <h2 className="text-xl font-semibold text-white">Verification in Progress</h2>
          </div>
        </div>
        
        <ServiceLoadingStatus 
          perplexityStatus={serviceStatus.perplexity}
          openAIStatus={serviceStatus.openai}
          anthropicStatus={serviceStatus.anthropic}
          errorMessages={errorMessages}
        />
        
        <p className="text-white/70 text-sm mt-6 text-center">
          Cross-referencing claims across multiple verification models for accuracy
        </p>
      </div>
    );
  }
  
  if (empiricalClaims.length === 0) {
    return null;
  }

  return (
    <div className="glass-panel p-6">
      <div className="mb-6">
        <div className="flex items-center space-x-2 mb-3">
          <div className="p-1.5 bg-primary/10 rounded-md">
            <Shield className="h-5 w-5 text-primary" />
          </div>
          <h2 className="text-xl font-semibold text-white">Verification Results</h2>
        </div>
        
        <div className="py-2 px-4 bg-white/5 border border-white/10 rounded-lg text-sm text-white/80">
          <p>We've identified {empiricalClaims.length} verifiable claim{empiricalClaims.length !== 1 ? 's' : ''} in this video</p>
        </div>
      </div>
      
      {/* Tabs - Cleaner Design */}
      <div className="border-b border-white/10 mb-6">
        <div className="flex flex-wrap -mb-px">
          <button
            onClick={() => setActiveTab('claims')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'claims' 
                ? 'border-primary text-primary' 
                : 'border-transparent text-white/70 hover:text-white/90 hover:border-white/20'}
            `}
          >
            <FileText className="h-4 w-4" />
            <span>Claims {empiricalClaims.length > 0 ? `(${empiricalClaims.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('perplexity')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'perplexity' 
                ? 'border-primary text-primary' 
                : 'border-transparent text-white/70 hover:text-white/90 hover:border-white/20'}
            `}
          >
            <div className="h-3 w-3 bg-blue-500 rounded-full"></div>
            <span>Perplexity {perplexityResults.length > 0 ? `(${perplexityResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('openai')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'openai' 
                ? 'border-primary text-primary' 
                : 'border-transparent text-white/70 hover:text-white/90 hover:border-white/20'}
            `}
          >
            <div className="h-3 w-3 bg-green-500 rounded-full"></div>
            <span>OpenAI {openAIResults.length > 0 ? `(${openAIResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('anthropic')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'anthropic' 
                ? 'border-primary text-primary' 
                : 'border-transparent text-white/70 hover:text-white/90 hover:border-white/20'}
            `}
          >
            <div className="h-3 w-3 bg-purple-500 rounded-full"></div>
            <span>Anthropic {anthropicResults.length > 0 ? `(${anthropicResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('comparison')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'comparison' 
                ? 'border-primary text-primary' 
                : 'border-transparent text-white/70 hover:text-white/90 hover:border-white/20'}
            `}
          >
            <BarChart4 className="h-4 w-4" />
            <span>AI Comparison</span>
          </button>
        </div>
      </div>
      
      {/* Tab Content */}
      <div className="overflow-hidden">
        {activeTab === 'claims' && (
          <div className="space-y-4">
            {empiricalClaims.map((claim, index) => (
              <div key={index} className="glass-panel p-6">
                <div className="flex items-center mb-4">
                  <div className="h-7 w-7 flex items-center justify-center bg-primary/10 text-primary rounded-full mr-3 font-medium text-sm">
                    {index + 1}
                  </div>
                  <h3 className="font-semibold text-white">Claim to Verify</h3>
                </div>
                
                <div className="space-y-3">
                  <div className="py-3 px-4 bg-white/5 border border-white/10 rounded-lg">
                    <p className="text-white/90 font-medium">{claim.claim}</p>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div>
                      <h4 className="text-sm font-medium text-white/70 mb-2">Context:</h4>
                      <p className="text-white/80 text-sm whitespace-pre-line p-3 bg-white/5 rounded-lg border border-white/10">{claim.context}</p>
                    </div>
                    
                    <div>
                      <h4 className="text-sm font-medium text-white/70 mb-2">Verification Approach:</h4>
                      <p className="text-white/80 text-sm p-3 bg-white/5 rounded-lg border border-white/10">{claim.validationPotential}</p>
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
        
        {activeTab === 'perplexity' && (
          <div className="space-y-4">
            {perplexityResults.length > 0 ? (
              perplexityResults.map((claim, index) => (
                <FactCheckCard key={index} claim={claim} />
              ))
            ) : serviceStatus.perplexity === 'loading' ? (
              <div className="py-6">
                <ServiceLoadingStatus 
                  perplexityStatus={serviceStatus.perplexity}
                  openAIStatus="idle"
                  anthropicStatus="idle"
                />
              </div>
            ) : (
              <div className="text-center py-10 bg-white/5 rounded-lg border border-white/10">
                <AlertCircle className="h-10 w-10 text-white/30 mx-auto mb-3" />
                <p className="text-white/70">No verification results available from Perplexity yet.</p>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'openai' && (
          <div className="space-y-4">
            {openAIResults.length > 0 ? (
              openAIResults.map((claim, index) => (
                <FactCheckCard key={index} claim={claim} />
              ))
            ) : serviceStatus.openai === 'loading' ? (
              <div className="py-6">
                <ServiceLoadingStatus 
                  perplexityStatus="idle"
                  openAIStatus={serviceStatus.openai}
                  anthropicStatus="idle"
                />
              </div>
            ) : (
              <div className="text-center py-10 bg-white/5 rounded-lg border border-white/10">
                <AlertCircle className="h-10 w-10 text-white/30 mx-auto mb-3" />
                <p className="text-white/70">No verification results available from OpenAI yet.</p>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'anthropic' && (
          <div className="space-y-4">
            {anthropicResults.length > 0 ? (
              anthropicResults.map((claim, index) => (
                <FactCheckCard key={index} claim={claim} />
              ))
            ) : serviceStatus.anthropic === 'loading' ? (
              <div className="py-6">
                <ServiceLoadingStatus 
                  perplexityStatus="idle"
                  openAIStatus="idle"
                  anthropicStatus={serviceStatus.anthropic}
                />
              </div>
            ) : (
              <div className="text-center py-10 bg-white/5 rounded-lg border border-white/10">
                <AlertCircle className="h-10 w-10 text-white/30 mx-auto mb-3" />
                <p className="text-white/70">No verification results available from Anthropic yet.</p>
              </div>
            )}
          </div>
        )}
        
        {activeTab === 'comparison' && (
          <ModelComparison
            perplexityResults={perplexityResults}
            openAIResults={openAIResults}
            anthropicResults={anthropicResults}
          />
        )}
      </div>
      
      <div className="mt-6 p-4 bg-white/5 border border-white/10 rounded-lg flex items-center justify-between">
        <div className="flex items-center">
          <Shield className="h-5 w-5 text-primary mr-2" />
          <span className="text-sm text-white/90 font-medium">Verified by Civic</span>
        </div>
        <div className="text-xs text-white/50">
          Multiple AI models cross-referenced to ensure accuracy
        </div>
      </div>
    </div>
  );
};

export default AnalysisResults;