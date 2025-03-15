import React, { useState } from 'react';
import { CheckCircle, XCircle, AlertCircle, BarChart4, FileText, Shield } from 'lucide-react';
import { ClaimAnalysis, Claim } from '../../types';
import FactCheckCard from './FactCheckCard';
import ModelComparison from './ModelComparison';
import ServiceLoadingStatus, { ServiceStatus } from './ServiceLoadingStatus';
import ClaimCard from './ClaimCard';

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
            <div className="p-1.5 bg-blue-100 rounded-md">
              <Shield className="h-5 w-5 text-blue-600" />
            </div>
            <h2 className="text-xl font-semibold text-gray-900">Verification in Progress</h2>
          </div>
        </div>
        
        <ServiceLoadingStatus 
          perplexityStatus={serviceStatus.perplexity}
          openAIStatus={serviceStatus.openai}
          anthropicStatus={serviceStatus.anthropic}
          errorMessages={errorMessages}
        />
        
        <p className="text-gray-700 text-sm mt-6 text-center">
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
          <div className="p-1.5 bg-blue-100 rounded-md">
            <Shield className="h-5 w-5 text-blue-600" />
          </div>
          <h2 className="text-xl font-semibold text-gray-900">Verification Results</h2>
        </div>
        
        <div className="py-2 px-4 bg-gray-50 border border-gray-200 rounded-lg text-sm text-gray-700">
          <p>We've identified {empiricalClaims.length} verifiable claim{empiricalClaims.length !== 1 ? 's' : ''} in this video</p>
        </div>
      </div>
      
      {/* Tabs - Cleaner Design */}
      <div className="border-b border-gray-200 mb-6">
        <div className="flex flex-wrap -mb-px">
          <button
            onClick={() => setActiveTab('claims')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'claims' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <FileText className="h-4 w-4" />
            <span>Claims {empiricalClaims.length > 0 ? `(${empiricalClaims.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('perplexity')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'perplexity' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <div className="h-3 w-3 bg-blue-500 rounded-full"></div>
            <span>Perplexity {perplexityResults.length > 0 ? `(${perplexityResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('openai')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'openai' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <div className="h-3 w-3 bg-green-500 rounded-full"></div>
            <span>OpenAI {openAIResults.length > 0 ? `(${openAIResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('anthropic')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'anthropic' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
            `}
          >
            <div className="h-3 w-3 bg-purple-500 rounded-full"></div>
            <span>Anthropic {anthropicResults.length > 0 ? `(${anthropicResults.length})` : ''}</span>
          </button>
          
          <button
            onClick={() => setActiveTab('comparison')}
            className={`mr-4 py-3 px-1 border-b-2 font-medium text-sm flex items-center space-x-1.5
              ${activeTab === 'comparison' 
                ? 'border-blue-600 text-blue-600' 
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
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
              <ClaimCard key={index} claim={claim} index={index} />
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
              <div className="text-center py-10 bg-white border border-gray-200 rounded-lg">
                <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700">No verification results available from Perplexity yet.</p>
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
              <div className="text-center py-10 bg-white border border-gray-200 rounded-lg">
                <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700">No verification results available from OpenAI yet.</p>
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
              <div className="text-center py-10 bg-white border border-gray-200 rounded-lg">
                <AlertCircle className="h-10 w-10 text-gray-300 mx-auto mb-3" />
                <p className="text-gray-700">No verification results available from Anthropic yet.</p>
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
      
      <div className="mt-6 p-4 bg-gray-50 border border-gray-200 rounded-lg flex items-center justify-between">
        <div className="flex items-center">
          <Shield className="h-5 w-5 text-blue-600 mr-2" />
          <span className="text-sm text-gray-800 font-medium">Verified by Civic</span>
        </div>
        <div className="text-xs text-gray-500">
          Multiple AI models cross-referenced to ensure accuracy
        </div>
      </div>
    </div>
  );
};

export default AnalysisResults;