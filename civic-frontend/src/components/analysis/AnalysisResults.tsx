import React, { useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, BarChart4 } from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';
import FactCheckCard from './FactCheckCard';
import ModelComparison from './ModelComparison';

interface AnalysisResultsProps {
  empiricalClaims: ClaimAnalysis[];
  perplexityResults: Claim[];
  openAIResults: Claim[];
  anthropicResults: Claim[];
  isLoading?: boolean;
}

type TabType = 'claims' | 'perplexity' | 'openai' | 'anthropic' | 'comparison';

const AnalysisResults: React.FC<AnalysisResultsProps> = ({
  empiricalClaims,
  perplexityResults,
  openAIResults,
  anthropicResults,
  isLoading = false,
}) => {
  const [activeTab, setActiveTab] = useState<TabType>('claims');
  
  if (isLoading) {
    return (
      <div className="glass-panel p-6 min-h-[400px] flex flex-col items-center justify-center">
        <div className="animate-spin h-10 w-10 border-4 border-primary border-t-transparent rounded-full mb-4"></div>
        <p className="text-white font-medium">Analyzing claims...</p>
        <p className="text-white/70 text-sm mt-2">This may take a minute</p>
      </div>
    );
  }
  
  if (empiricalClaims.length === 0) {
    return null;
  }
  
  const getTabIcon = (tab: TabType) => {
    switch (tab) {
      case 'claims':
        return <AlertCircle className="h-5 w-5" />;
      case 'perplexity':
      case 'openai':
      case 'anthropic':
        return <CheckCircle className="h-5 w-5" />;
      case 'comparison':
        return <BarChart4 className="h-5 w-5" />;
      default:
        return null;
    }
  };
  
  const getResultCount = (tab: TabType) => {
    switch (tab) {
      case 'claims':
        return empiricalClaims.length;
      case 'perplexity':
        return perplexityResults.length;
      case 'openai':
        return openAIResults.length;
      case 'anthropic':
        return anthropicResults.length;
      default:
        return 0;
    }
  };

  return (
    <div className="glass-panel p-6">
      <h2 className="text-xl font-semibold mb-6 text-white flex items-center">
        <BarChart4 className="mr-2 h-5 w-5 text-primary" />
        Analysis Results
      </h2>
      
      {/* Tabs */}
      <div className="flex flex-wrap gap-2 mb-6">
        {(['claims', 'perplexity', 'openai', 'anthropic', 'comparison'] as TabType[]).map((tab) => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            className={`
              flex items-center space-x-1.5 px-4 py-2 rounded-full text-sm font-medium
              border transition-colors
              ${activeTab === tab 
                ? 'bg-primary/20 border-primary/50 text-white' 
                : 'bg-white/5 border-white/10 text-white/70 hover:bg-white/10'
              }
            `}
          >
            <span className={activeTab === tab ? 'text-primary' : 'text-white/50'}>
              {getTabIcon(tab)}
            </span>
            <span>
              {tab.charAt(0).toUpperCase() + tab.slice(1)}
              {tab !== 'comparison' && getResultCount(tab) > 0 && 
                ` (${getResultCount(tab)})`
              }
            </span>
          </button>
        ))}
      </div>
      
      {/* Tab Content */}
      <div className="overflow-hidden">
        {activeTab === 'claims' && (
          <div className="space-y-4">
            {empiricalClaims.map((claim, index) => (
              <div key={index} className="glass-panel p-6">
                <div className="space-y-3">
                  <div>
                    <h3 className="font-semibold text-white mb-2">Claim:</h3>
                    <p className="text-white/90">{claim.claim}</p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-white mb-2">Context:</h3>
                    <p className="text-white/90 whitespace-pre-line">{claim.context}</p>
                  </div>
                  
                  <div>
                    <h3 className="font-semibold text-white mb-2">Validation Approach:</h3>
                    <p className="text-white/90">{claim.validationPotential}</p>
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
            ) : (
              <div className="text-center py-12">
                <CircleAlert className="h-12 w-12 text-white/30 mx-auto mb-4" />
                <p className="text-white/70">No Perplexity results available yet.</p>
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
            ) : (
              <div className="text-center py-12">
                <CircleAlert className="h-12 w-12 text-white/30 mx-auto mb-4" />
                <p className="text-white/70">No OpenAI results available yet.</p>
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
            ) : (
              <div className="text-center py-12">
                <CircleAlert className="h-12 w-12 text-white/30 mx-auto mb-4" />
                <p className="text-white/70">No Anthropic results available yet.</p>
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
    </div>
  );
};

export default AnalysisResults;