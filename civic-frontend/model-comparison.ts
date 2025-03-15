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
        <BarChart3 className="h-12 w-12 text-white/30 mx-auto mb-4" />
        <p className="text-white/70">No analysis results available for comparison.</p>
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
          <h3 className="text-lg font-medium text-white mb-4 border-b border-white/10 pb-3">
            Claim: {item.statement}
          </h3>
          
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {/* Perplexity */}
            <div className="glass-panel p-4">
              <h4 className="text-white font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-primary rounded-full mr-2"></div>
                Perplexity
              </h4>
              
              {item.perplexity ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <StatusBadge status={item.perplexity.classification} size="sm" />
                    <div className="text-xs text-white/70 bg-white/10 px-2 py-0.5 rounded-full">
                      {item.perplexity.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-white/80 line-clamp-4">
                    {item.perplexity.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-white/50 text-sm italic">No data available</div>
              )}
            </div>
            
            {/* OpenAI */}
            <div className="glass-panel p-4">
              <h4 className="text-white font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-green-500 rounded-full mr-2"></div>
                OpenAI
              </h4>
              
              {item.openai ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <StatusBadge status={item.openai.classification} size="sm" />
                    <div className="text-xs text-white/70 bg-white/10 px-2 py-0.5 rounded-full">
                      {item.openai.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-white/80 line-clamp-4">
                    {item.openai.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-white/50 text-sm italic">No data available</div>
              )}
            </div>
            
            {/* Anthropic */}
            <div className="glass-panel p-4">
              <h4 className="text-white font-medium mb-3 flex items-center">
                <div className="h-3 w-3 bg-purple-500 rounded-full mr-2"></div>
                Anthropic
              </h4>
              
              {item.anthropic ? (
                <div className="space-y-3">
                  <div className="flex items-center justify-between">
                    <StatusBadge status={item.anthropic.classification} size="sm" />
                    <div className="text-xs text-white/70 bg-white/10 px-2 py-0.5 rounded-full">
                      {item.anthropic.confidence}%
                    </div>
                  </div>
                  <p className="text-xs text-white/80 line-clamp-4">
                    {item.anthropic.supportingFacts.slice(0, 150)}...
                  </p>
                </div>
              ) : (
                <div className="text-white/50 text-sm italic">No data available</div>
              )}
            </div>
          </div>
          
          {/* Confidence comparison */}
          <div className="mt-6 pt-4 border-t border-white/10">
            <h4 className="text-white text-sm font-medium mb-3">Confidence Comparison</h4>
            <div className="flex items-end h-16 space-x-3">
              {item.perplexity && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-white/70 mb-1">{item.perplexity.confidence}%</div>
                  <div 
                    className="w-12 bg-primary rounded-t-md" 
                    style={{ height: `${item.perplexity.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-white/70 mt-1">Perplexity</div>
                </div>
              )}
              
              {item.openai && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-white/70 mb-1">{item.openai.confidence}%</div>
                  <div 
                    className="w-12 bg-green-500 rounded-t-md" 
                    style={{ height: `${item.openai.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-white/70 mt-1">OpenAI</div>
                </div>
              )}
              
              {item.anthropic && (
                <div className="flex flex-col items-center">
                  <div className="text-xs text-white/70 mb-1">{item.anthropic.confidence}%</div>
                  <div 
                    className="w-12 bg-purple-500 rounded-t-md" 
                    style={{ height: `${item.anthropic.confidence * 0.6}px` }}
                  ></div>
                  <div className="text-xs text-white/70 mt-1">Anthropic</div>
                </div>
              )}
            </div>
          </div>
          
          {/* Agreement/Disagreement */}
          {(item.perplexity && item.openai && item.anthropic) && (
            <div className="mt-4 pt-2">
              <div className="text-sm text-white/70">
                <span className="font-medium text-white">Analysis: </span>
                {(item.perplexity.classification === item.openai.classification && 
                  item.openai.classification === item.anthropic.classification) ? (
                  <span className="text-status-true">All models agree on this claim.</span>
                ) : (
                  <span className="text-status-unverified">Models have different assessments of this claim.</span>
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
