import React from 'react';
import { BarChart3 } from 'lucide-react';
import { Claim } from '../../types';
import StatusBadge from '../ui/StatusBadge';

interface ModelComparisonProps {
  perplexityResults: Claim[];
  openAIResults: Claim[];
  anthropicResults: Claim[];
}

const ModelComparison: React.FC<ModelComparisonProps> = ({
  perplexityResults,
  openAIResults,
  anthropicResults,
}) => {
  // If no results, display a message
  if (!perplexityResults.length && !openAIResults.length && !anthropicResults.length) {
    return (
      <div className="text-center py-12">
        <BarChart3 className="h-12 w-12 text-gray-300 mx-auto mb-4" />
        <p className="text-gray-700">No analysis results available for comparison.</p>
      </div>
    );
  }
  
  // Find the maximum number of claims
  const maxClaims = Math.max(
    perplexityResults.length,
    openAIResults.length,
    anthropicResults.length
  );
  
  // Build comparison data
  const comparisonItems = [];
  
  for (let i = 0; i < maxClaims; i++) {
    // Get claims if they exist
    const perplexityClaim = perplexityResults[i];
    const openAIClaim = openAIResults[i];
    const anthropicClaim = anthropicResults[i];
    
    // Use the first available claim statement
    const statement = perplexityClaim?.statement || 
                     openAIClaim?.statement || 
                     anthropicClaim?.statement || 
                     'Unknown Claim';
    
    comparisonItems.push({
      statement,
      perplexity: perplexityClaim,
      openai: openAIClaim,
      anthropic: anthropicClaim
    });
  }

  return (
    <div className="space-y-6">
      {comparisonItems.map((item, index) => (
        <div key={index} className="glass-panel p-6">
          <h3 className="text-lg font-medium text-gray-900 mb-4 border-b border-gray-200 pb-3">
            <span className="font-semibold">Claim:</span> {item.statement}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Perplexity */}
            <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
              <h4 className="text-gray-800 font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-blue-500 rounded-full mr-2"></div>
                Perplexity
              </h4>
              
              {item.perplexity ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="px-2.5 py-1 text-xs font-medium rounded-full bg-gray-100 border border-gray-200">
                      {item.perplexity.classification === 'TRUE' && (
                        <span className="text-green-700">True</span>
                      )}
                      {item.perplexity.classification === 'FALSE' && (
                        <span className="text-red-700">False</span>
                      )}
                      {item.perplexity.classification === 'UNVERIFIED' && (
                        <span className="text-amber-700">Unverified</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full">
                      {item.perplexity.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-gray-700 line-clamp-4">
                    {item.perplexity.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-gray-500 text-sm italic">No data available</div>
              )}
            </div>
            
            {/* OpenAI */}
            <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
              <h4 className="text-gray-800 font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-green-500 rounded-full mr-2"></div>
                OpenAI
              </h4>
              
              {item.openai ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="px-2.5 py-1 text-xs font-medium rounded-full bg-gray-100 border border-gray-200">
                      {item.openai.classification === 'TRUE' && (
                        <span className="text-green-700">True</span>
                      )}
                      {item.openai.classification === 'FALSE' && (
                        <span className="text-red-700">False</span>
                      )}
                      {item.openai.classification === 'UNVERIFIED' && (
                        <span className="text-amber-700">Unverified</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full">
                      {item.openai.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-gray-700 line-clamp-4">
                    {item.openai.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-gray-500 text-sm italic">No data available</div>
              )}
            </div>
            
            {/* Anthropic */}
            <div className="p-4 border border-gray-200 rounded-lg bg-white shadow-sm">
              <h4 className="text-gray-800 font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-purple-500 rounded-full mr-2"></div>
                Anthropic
              </h4>
              
              {item.anthropic ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <div className="px-2.5 py-1 text-xs font-medium rounded-full bg-gray-100 border border-gray-200">
                      {item.anthropic.classification === 'TRUE' && (
                        <span className="text-green-700">True</span>
                      )}
                      {item.anthropic.classification === 'FALSE' && (
                        <span className="text-red-700">False</span>
                      )}
                      {item.anthropic.classification === 'UNVERIFIED' && (
                        <span className="text-amber-700">Unverified</span>
                      )}
                    </div>
                    <div className="text-xs text-gray-700 bg-gray-100 px-2 py-0.5 rounded-full">
                      {item.anthropic.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-gray-700 line-clamp-4">
                    {item.anthropic.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-gray-500 text-sm italic">No data available</div>
              )}
            </div>
          </div>
          
          {/* Confidence comparison */}
          <div className="mt-6 pt-4 border-t border-gray-200">
            <h4 className="text-gray-800 text-sm font-medium mb-3">Confidence Comparison</h4>
            <div className="flex items-end h-16 space-x-3">
              {item.perplexity && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-gray-700 mb-1">{item.perplexity.confidence}%</div>
                  <div 
                    className="w-12 bg-blue-500 rounded-t-md" 
                    style={{ height: `${item.perplexity.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-gray-700 mt-1">Perplexity</div>
                </div>
              )}
              
              {item.openai && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-gray-700 mb-1">{item.openai.confidence}%</div>
                  <div 
                    className="w-12 bg-green-500 rounded-t-md" 
                    style={{ height: `${item.openai.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-gray-700 mt-1">OpenAI</div>
                </div>
              )}
              
              {item.anthropic && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-gray-700 mb-1">{item.anthropic.confidence}%</div>
                  <div 
                    className="w-12 bg-purple-500 rounded-t-md" 
                    style={{ height: `${item.anthropic.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-gray-700 mt-1">Anthropic</div>
                </div>
              )}
            </div>
          </div>
          
          {/* Agreement/Disagreement */}
          {(item.perplexity && item.openai && item.anthropic) && (
            <div className="mt-4 pt-2">
              <div className="text-sm text-gray-700">
                <span className="font-medium text-gray-800">Analysis: </span>
                {(item.perplexity.classification === item.openai.classification && 
                  item.openai.classification === item.anthropic.classification) ? (
                  <span className="text-green-700">All models agree on this claim.</span>
                ) : (
                  <span className="text-amber-700">Models have different assessments of this claim.</span>
                )}
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  );
};

export default ModelComparison;