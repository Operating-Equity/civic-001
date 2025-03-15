import React, { useState } from 'react';
import { 
  ChevronDown, ChevronUp, ExternalLink, BarChart2, 
  Book, FileText, Lightbulb, Link, CheckCircle, XCircle, AlertCircle,
  Scale, Brain, Database, AlignLeft
} from 'lucide-react';
import { Claim } from '../../types';

interface FactCheckCardProps {
  claim: Claim;
}

const FactCheckCard: React.FC<FactCheckCardProps> = ({ claim }) => {
  const [expanded, setExpanded] = useState(false);
  const [activeSection, setActiveSection] = useState<'analysis' | 'evidence' | 'reasoning' | 'principles'>('analysis');
  
  const formatSupportingFacts = (text: string) => {
    // Convert markdown-like syntax to HTML
    // Convert bold
    let formatted = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    
    // Convert lists
    const lines = formatted.split('\n');
    let inList = false;
    const processedLines = lines.map(line => {
      const trimmedLine = line.trim();
      if (trimmedLine.startsWith('- ') || trimmedLine.startsWith('* ')) {
        if (!inList) {
          inList = true;
          return '<ul class="list-disc pl-6 mt-2 mb-2"><li>' + trimmedLine.substring(2) + '</li>';
        }
        return '<li>' + trimmedLine.substring(2) + '</li>';
      } else if (inList) {
        inList = false;
        return '</ul>' + line;
      }
      return line;
    });
    
    if (inList) {
      processedLines.push('</ul>');
    }
    
    // Replace line breaks with <br />
    return processedLines.join('\n').replace(/\n/g, '<br />');
  };
  
  const getVerificationBadge = () => {
    switch (claim.classification) {
      case 'TRUE':
        return (
          <div className="px-3 py-1.5 bg-green-100 text-green-700 border border-green-200 rounded-full font-medium text-sm flex items-center shadow-sm">
            <CheckCircle className="w-4 h-4 mr-1.5" />
            Verified True
          </div>
        );
      case 'FALSE':
        return (
          <div className="px-3 py-1.5 bg-red-100 text-red-700 border border-red-200 rounded-full font-medium text-sm flex items-center shadow-sm">
            <XCircle className="w-4 h-4 mr-1.5" />
            False Claim
          </div>
        );
      case 'UNVERIFIED':
      default:
        return (
          <div className="px-3 py-1.5 bg-amber-100 text-amber-700 border border-amber-200 rounded-full font-medium text-sm flex items-center shadow-sm">
            <AlertCircle className="w-4 h-4 mr-1.5" />
            Needs Verification
          </div>
        );
    }
  };
  
  // Extract definitions, principles, evidence, and reasoning from detailed analysis or supporting facts
  const extractSections = () => {
    const detailedAnalysis = claim.detailedAnalysis;
    
    if (detailedAnalysis) {
      return {
        definitions: detailedAnalysis.definitions || [],
        principles: detailedAnalysis.principles || [],
        evidence: detailedAnalysis.evidence || [],
        analysis: detailedAnalysis.analysis || '',
        conclusion: detailedAnalysis.conclusion || ''
      };
    }
    
    // If no detailed analysis, try to parse from supporting facts
    const supportingFacts = claim.supportingFacts || '';
    
    // Simple regex-based extraction for sections
    const definitionsMatch = supportingFacts.match(/Definitions?[:\n]+((?:[\s\S]+?))(?:Principles|Evidence|Analysis|$)/i);
    const principlesMatch = supportingFacts.match(/Principles?[:\n]+((?:[\s\S]+?))(?:Evidence|Analysis|Definitions|$)/i);
    const evidenceMatch = supportingFacts.match(/Evidence[:\n]+((?:[\s\S]+?))(?:Analysis|Conclusion|Principles|$)/i);
    const analysisMatch = supportingFacts.match(/Analysis[:\n]+((?:[\s\S]+?))(?:Conclusion|Evidence|$)/i);
    const conclusionMatch = supportingFacts.match(/Conclusion[:\n]+((?:[\s\S]+?))(?:Confidence|$)/i);
    
    return {
      definitions: definitionsMatch ? 
        definitionsMatch[1].split('\n').filter(line => line.trim().length > 0) : [],
      principles: principlesMatch ? 
        principlesMatch[1].split('\n').filter(line => line.trim().length > 0) : [],
      evidence: evidenceMatch ? 
        extractEvidenceItems(evidenceMatch[1]) : [],
      analysis: analysisMatch ? analysisMatch[1].trim() : '',
      conclusion: conclusionMatch ? conclusionMatch[1].trim() : ''
    };
  };
  
  const extractEvidenceItems = (evidenceText: string) => {
    // Simple extraction of evidence items
    const items = evidenceText.split(/\n(?=[-*•]\s)/).filter(item => item.trim());
    
    return items.map(item => {
      const sourceMatch = item.match(/source:\s*(.+)/i);
      return {
        fact: item.replace(/source:\s*.+/i, '').trim(),
        source: sourceMatch ? sourceMatch[1].trim() : 'Not specified'
      };
    });
  };
  
  const sections = extractSections();

  return (
    <div className="bg-white p-6 border border-gray-200 rounded-lg shadow-sm">
      <div className="flex flex-col sm:flex-row sm:justify-between sm:items-start gap-4 mb-4">
        <div className="space-y-3">
          <div>
            {getVerificationBadge()}
          </div>
          <p className="font-medium text-gray-800 text-lg leading-tight">{claim.statement}</p>
        </div>
        
        <div className="flex flex-col items-end gap-2">
          <div className="flex items-center space-x-1.5 gap-1.5">
            <div className="flex items-center bg-gray-100 px-3 py-1 rounded-lg text-sm border border-gray-200">
              <BarChart2 className="h-3.5 w-3.5 text-gray-500 mr-1.5" />
              <span className="text-gray-800 font-medium">{claim.confidence}%</span>
              <span className="text-gray-500 ml-1">confidence</span>
            </div>
            
            {claim.model && (
              <div className="text-xs text-gray-600 bg-gray-100 px-2 py-1 rounded-lg border border-gray-200">
                {claim.model}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="text-gray-700 text-sm">
        {claim.error ? (
          <div className="p-4 mb-4 border border-amber-300 rounded-lg bg-amber-50">
            <div className="flex items-center">
              <AlertCircle className="w-5 h-5 mr-2 text-amber-500" />
              <h3 className="text-base font-medium text-amber-700">Verification Issue</h3>
            </div>
            <div className="mt-2 text-amber-700">
              <p>{claim.error}</p>
            </div>
          </div>
        ) : expanded ? (
          <>
            {/* Analysis Tabs */}
            <div className="mb-4 border-b border-gray-200">
              <div className="flex flex-wrap -mb-px overflow-x-auto">
                <button
                  onClick={() => setActiveSection('analysis')}
                  className={`mr-4 py-2 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
                    ${activeSection === 'analysis' 
                      ? 'border-blue-600 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
                  `}
                >
                  <AlignLeft className="h-4 w-4" />
                  <span>Analysis</span>
                </button>
                
                <button
                  onClick={() => setActiveSection('evidence')}
                  className={`mr-4 py-2 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
                    ${activeSection === 'evidence' 
                      ? 'border-blue-600 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
                  `}
                >
                  <Database className="h-4 w-4" />
                  <span>Evidence</span>
                </button>
                
                <button
                  onClick={() => setActiveSection('reasoning')}
                  className={`mr-4 py-2 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
                    ${activeSection === 'reasoning' 
                      ? 'border-blue-600 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
                  `}
                >
                  <Brain className="h-4 w-4" />
                  <span>Reasoning</span>
                </button>
                
                <button
                  onClick={() => setActiveSection('principles')}
                  className={`mr-4 py-2 px-3 border-b-2 font-medium text-sm flex items-center space-x-1.5
                    ${activeSection === 'principles' 
                      ? 'border-blue-600 text-blue-600' 
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'}
                  `}
                >
                  <Scale className="h-4 w-4" />
                  <span>Principles</span>
                </button>
              </div>
            </div>
            
            {/* Tab Content */}
            <div className="p-4 rounded-lg bg-gray-50 border border-gray-200">
              {activeSection === 'analysis' && (
                <div className="space-y-4">
                  {/* Analysis content */}
                  <div>
                    <h4 className="text-gray-800 font-medium mb-2 flex items-center">
                      <AlignLeft className="h-4 w-4 mr-1.5 text-blue-500" />
                      Analysis
                    </h4>
                    <p className="text-gray-700 whitespace-pre-line">
                      {sections.analysis || 'No detailed analysis provided.'}
                    </p>
                  </div>
                  
                  {sections.conclusion && (
                    <div className="pt-3 mt-3 border-t border-gray-200">
                      <h4 className="text-gray-800 font-medium mb-2 flex items-center">
                        <Lightbulb className="h-4 w-4 mr-1.5 text-blue-500" />
                        Conclusion
                      </h4>
                      <p className="text-gray-700">
                        {sections.conclusion}
                      </p>
                    </div>
                  )}
                </div>
              )}
              
              {activeSection === 'evidence' && (
                <div>
                  <h4 className="text-gray-800 font-medium mb-3 flex items-center">
                    <Database className="h-4 w-4 mr-1.5 text-blue-500" />
                    Supporting Evidence
                  </h4>
                  
                  {sections.evidence && sections.evidence.length > 0 ? (
                    <ul className="space-y-3">
                      {sections.evidence.map((item, idx) => (
                        <li key={idx} className="bg-white p-3 border border-gray-200 rounded-md">
                          <p className="text-gray-800">{item.fact}</p>
                          {item.source && item.source !== 'Not specified' && (
                            <div className="mt-1 text-xs text-gray-500 flex items-center">
                              <Link className="h-3 w-3 mr-1" />
                              Source: 
                              {item.source.startsWith('http') ? (
                                <a 
                                  href={item.source} 
                                  target="_blank" 
                                  rel="noopener noreferrer"
                                  className="text-blue-600 hover:underline ml-1 inline-flex items-center"
                                >
                                  {item.source.substring(0, 30)}...
                                  <ExternalLink className="h-3 w-3 ml-1" />
                                </a>
                              ) : (
                                <span className="ml-1">{item.source}</span>
                              )}
                            </div>
                          )}
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-gray-700 italic">No specific evidence items were provided.</p>
                  )}
                </div>
              )}
              
              {activeSection === 'reasoning' && (
                <div>
                  <h4 className="text-gray-800 font-medium mb-3 flex items-center">
                    <Brain className="h-4 w-4 mr-1.5 text-blue-500" />
                    Reasoning Process
                  </h4>
                  
                  {/* Show raw supporting facts if no specific reasoning sections are available */}
                  <div className="text-gray-700">
                    {claim.supportingFacts ? (
                      <div 
                        className="whitespace-pre-line"
                        dangerouslySetInnerHTML={{ __html: formatSupportingFacts(claim.supportingFacts) }}
                      />
                    ) : (
                      <p className="italic">No reasoning details provided.</p>
                    )}
                  </div>
                </div>
              )}
              
              {activeSection === 'principles' && (
                <div className="space-y-4">
                  {/* Definitions Section */}
                  <div>
                    <h4 className="text-gray-800 font-medium mb-2 flex items-center">
                      <Book className="h-4 w-4 mr-1.5 text-blue-500" />
                      Definitions
                    </h4>
                    
                    {sections.definitions && sections.definitions.length > 0 ? (
                      <ul className="space-y-2 pl-6 list-disc">
                        {sections.definitions.map((definition, idx) => (
                          <li key={idx} className="text-gray-700">{definition}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-gray-700 italic">No specific definitions were provided.</p>
                    )}
                  </div>
                  
                  {/* Principles Section */}
                  <div className="pt-3 mt-3 border-t border-gray-200">
                    <h4 className="text-gray-800 font-medium mb-2 flex items-center">
                      <Scale className="h-4 w-4 mr-1.5 text-blue-500" />
                      Principles Applied
                    </h4>
                    
                    {sections.principles && sections.principles.length > 0 ? (
                      <ul className="space-y-2 pl-6 list-disc">
                        {sections.principles.map((principle, idx) => (
                          <li key={idx} className="text-gray-700">{principle}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-gray-700 italic">No specific principles were provided.</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="p-4 rounded-lg bg-gray-50 line-clamp-3 text-gray-700 border border-gray-200">
            {claim.supportingFacts ? 
              `${claim.supportingFacts.substring(0, 200)}...` : 
              claim.error ? 
                `Error: ${claim.error}` : 
                'No supporting facts available for this claim.'
            }
          </div>
        )}
      </div>
      
      <button
        onClick={() => setExpanded(!expanded)}
        className="mt-4 flex items-center text-blue-600 hover:text-blue-800 text-sm font-medium"
      >
        {expanded ? (
          <>
            <ChevronUp className="h-4 w-4 mr-1" />
            Show Less
          </>
        ) : (
          <>
            <ChevronDown className="h-4 w-4 mr-1" />
            Show Verification Details
          </>
        )}
      </button>
    </div>
  );
};

export default FactCheckCard;