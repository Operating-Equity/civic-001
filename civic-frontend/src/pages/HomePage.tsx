import React, { useState, useEffect } from 'react';
import { Shield, CheckCircle, AlertTriangle, File, ArrowRight, Search } from 'lucide-react';
import VideoInput from '../components/video/VideoInput';
import VideoThumbnail from '../components/video/VideoThumbnail';
import TranscriptDisplay from '../components/video/TranscriptDisplay';
import Summary from '../components/analysis/Summary';
import ClaimEvaluator from '../components/analysis/ClaimEvaluator';
import AnalysisResults from '../components/analysis/AnalysisResults';
import KeywordGeneration from '../components/search/KeywordGeneration';
import EvidenceResults from '../components/search/EvidenceResults';
import { useVideoAnalysis } from '../hooks/useVideoAnalysis';
import { useEvidenceSearch } from '../hooks/useEvidenceSearch';
import ServiceLoadingStatus from '../components/analysis/ServiceLoadingStatus';

const HomePage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'analysis' | 'evidence'>('analysis');
  
  const {
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    perplexityResults,
    openAIResults,
    anthropicResults,
    isLoading,
    error,
    serviceStatus,
    errorMessages,
    processingClaimIndex,
    handleVideoSubmit
  } = useVideoAnalysis();
  
  const {
    keywordResults,
    searchResults,
    isSearching,
    searchForEvidence,
    searchAllClaims
  } = useEvidenceSearch(empiricalClaims, videoTitle);
  
  const hasResults = transcript && !isLoading;
  const isProcessingClaims = processingClaimIndex >= 0;
  
  // Debug logging for tracking state changes
  useEffect(() => {
    console.log("[DEBUG] Processing Claim Index:", processingClaimIndex);
    console.log("[DEBUG] Service Status:", serviceStatus);
    console.log("[DEBUG] Result counts:", {
      perplexity: perplexityResults.length,
      openAI: openAIResults.length,
      anthropic: anthropicResults.length
    });
  }, [processingClaimIndex, serviceStatus, perplexityResults, openAIResults, anthropicResults]);
  
  // Feature icons for homepage
  const features = [
    {
      icon: <File className="h-6 w-6 text-primary" />,
      title: "Transcript Analysis",
      description: "Extract and analyze transcripts from YouTube videos or uploaded files."
    },
    {
      icon: <CheckCircle className="h-6 w-6 text-green-500" />,
      title: "Multi-Model Fact-Checking",
      description: "Cross-reference claims across multiple AI models to ensure reliable results."
    },
    {
      icon: <Search className="h-6 w-6 text-purple-500" />,
      title: "Evidence Search",
      description: "Automatically search for supporting evidence from reputable sources."
    },
    {
      icon: <AlertTriangle className="h-6 w-6 text-amber-500" />,
      title: "Claim Verification",
      description: "Evaluate empirical claims for accuracy, context, and supporting evidence."
    }
  ];

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section className="relative py-20 overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-b from-background-dark to-background-dark/90 z-0"></div>
        <div className="absolute inset-0 opacity-20 z-0">
          <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZGVmcz48cGF0dGVybiBpZD0iZ3JpZCIgd2lkdGg9IjIwIiBoZWlnaHQ9IjIwIiBwYXR0ZXJuVW5pdHM9InVzZXJTcGFjZU9uVXNlIj48cGF0aCBkPSJNIDIwIDAgTCAwIDAgTCAwIDIwIiBmaWxsPSJub25lIiBzdHJva2U9IiNmZmZmZmYiIHN0cm9rZS13aWR0aD0iMSIgb3BhY2l0eT0iMC4yIi8+PC9wYXR0ZXJuPjwvZGVmcz48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSJ1cmwoI2dyaWQpIiAvPjwvc3ZnPg==')]"></div>
        </div>
        
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center max-w-3xl mx-auto mb-12">
            <div className="flex justify-center mb-6">
              <Shield className="h-16 w-16 text-primary" />
            </div>
            
            <h1 className="text-4xl md:text-5xl font-bold text-white mb-6 tracking-tight">
              Advanced Video Fact-Checking with AI
            </h1>
            
            <p className="text-xl text-white/80 mb-8">
              Civic helps you analyze videos, extract empirical claims, and verify facts using multiple AI models and evidence search.
            </p>
            
            <div className="flex flex-wrap justify-center gap-4">
              <button className="px-6 py-3 bg-primary hover:bg-primary-600 text-white font-medium rounded-lg shadow-lg shadow-primary/20 transition-all duration-200 transform hover:translate-y-[-2px]">
                Get Started
              </button>
              
              <button className="px-6 py-3 bg-white/10 hover:bg-white/20 text-white font-medium rounded-lg border border-white/20 transition-colors">
                Learn More
              </button>
            </div>
          </div>
        </div>
      </section>
      
      {/* Features */}
      <section id="features" className="py-20 bg-background-dark">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-white text-center mb-12">
            Key Features
          </h2>
          
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-8">
            {features.map((feature, index) => (
              <div key={index} className="glass-panel p-6 flex flex-col items-center text-center">
                <div className="mb-4">
                  {feature.icon}
                </div>
                <h3 className="text-xl font-semibold text-white mb-2">
                  {feature.title}
                </h3>
                <p className="text-white/70">
                  {feature.description}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>
      
      {/* Video Analysis Section */}
      <section id="analysis" className="py-20 bg-background-dark/95">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-white text-center mb-12">
            Analyze Your Video
          </h2>
          
          <div className="max-w-4xl mx-auto">
            <VideoInput onVideoSubmit={handleVideoSubmit} isProcessing={isLoading} error={error} />
            
            {error && (
              <div className="mt-6 p-4 bg-red-900/50 border border-red-500/50 rounded-lg text-white">
                <div className="flex items-center space-x-2">
                  <AlertTriangle className="h-5 w-5 text-red-400" />
                  <p className="font-medium">Error</p>
                </div>
                <p className="mt-1 text-white/90">{error}</p>
              </div>
            )}
            
            {isLoading && (
              <div className="mt-8 glass-panel p-12 flex flex-col items-center justify-center">
                <div className="animate-spin h-12 w-12 border-4 border-primary border-t-transparent rounded-full mb-4"></div>
                <p className="text-xl font-medium text-white">Processing Video</p>
                <p className="text-white/70 mt-2">This may take a minute...</p>
              </div>
            )}
          </div>
        </div>
      </section>
      
      {/* Results Section (conditionally rendered) */}
      {hasResults && (
        <section className="py-20 bg-background-dark/90">
          <div className="container mx-auto px-4">
            <div className="max-w-6xl mx-auto">
              <div className="mb-8 flex flex-wrap gap-4">
                <button
                  className={`px-6 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2
                    ${activeSection === 'analysis' ? 'bg-primary text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
                  onClick={() => setActiveSection('analysis')}
                >
                  <CheckCircle className="h-5 w-5 mr-2" />
                  <span>Analysis Results</span>
                </button>
                
                <button
                  className={`px-6 py-3 rounded-lg font-medium transition-colors flex items-center space-x-2
                    ${activeSection === 'evidence' ? 'bg-primary text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'}`}
                  onClick={() => setActiveSection('evidence')}
                >
                  <Search className="h-5 w-5 mr-2" />
                  <span>Evidence Search</span>
                </button>
                
                {activeSection === 'evidence' && keywordResults.length > 0 && searchResults.length === 0 && (
                  <button
                    className="px-6 py-3 bg-primary/20 hover:bg-primary/30 text-primary font-medium rounded-lg transition-colors border border-primary/30 ml-auto"
                    onClick={searchAllClaims}
                    disabled={isSearching}
                  >
                    {isSearching ? (
                      <div className="flex items-center space-x-2">
                        <div className="animate-spin h-4 w-4 border-2 border-primary/50 border-t-primary rounded-full"></div>
                        <span>Searching...</span>
                      </div>
                    ) : (
                      <div className="flex items-center space-x-2">
                        <Search className="h-4 w-4" />
                        <span>Search All Claims</span>
                      </div>
                    )}
                  </button>
                )}
              </div>
              
              {/* Video Thumbnail */}
              <VideoThumbnail thumbnailUrl={thumbnailUrl} videoTitle={videoTitle} />
              
              {activeSection === 'analysis' ? (
                <>
                  {/* Analysis Results */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                    <TranscriptDisplay transcript={transcript} />
                    <Summary summary={summary} videoTitle={videoTitle} />
                  </div>
                  
                  {/* Display processing status if claims are being evaluated */}
                  {isProcessingClaims && (
                    <div className="mt-8 glass-panel p-6">
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
                        Processing claim {processingClaimIndex + 1} of {empiricalClaims.length}. This may take a minute.
                      </p>
                    </div>
                  )}
                  
                  <div className="mt-8">
                    <AnalysisResults
                      empiricalClaims={empiricalClaims}
                      perplexityResults={perplexityResults}
                      openAIResults={openAIResults}
                      anthropicResults={anthropicResults}
                      isLoading={isProcessingClaims}
                      serviceStatus={serviceStatus}
                      errorMessages={errorMessages}
                    />
                  </div>
                </>
              ) : (
                <>
                  {/* Evidence Search */}
                  <div className="mt-6">
                    <KeywordGeneration
                      keywordResults={keywordResults}
                      onSearch={searchForEvidence}
                      isSearching={isSearching}
                    />
                  </div>
                  
                  <div className="mt-8">
                    <EvidenceResults
                      searchResults={searchResults}
                      isSearching={isSearching}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}
      
      {/* How it works */}
      <section id="how-it-works" className="py-20 bg-background-dark">
        <div className="container mx-auto px-4">
          <h2 className="text-3xl font-bold text-white text-center mb-12">
            How It Works
          </h2>
          
          <div className="max-w-4xl mx-auto">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
              <div className="glass-panel p-6 relative">
                <div className="absolute -top-4 -left-4 w-10 h-10 rounded-full bg-primary flex items-center justify-center font-bold text-white text-xl">1</div>
                <h3 className="text-xl font-semibold text-white mb-3 mt-2">Upload Video</h3>
                <p className="text-white/70">
                  Provide a YouTube URL or upload a video file. Our system extracts the transcript and processes it.
                </p>
                <div className="mt-4 flex justify-end">
                  <ArrowRight className="h-5 w-5 text-primary" />
                </div>
              </div>
              
              <div className="glass-panel p-6 relative">
                <div className="absolute -top-4 -left-4 w-10 h-10 rounded-full bg-primary flex items-center justify-center font-bold text-white text-xl">2</div>
                <h3 className="text-xl font-semibold text-white mb-3 mt-2">AI Analysis</h3>
                <p className="text-white/70">
                  Multiple AI models extract and evaluate empirical claims, providing accuracy ratings and confidence scores.
                </p>
                <div className="mt-4 flex justify-end">
                  <ArrowRight className="h-5 w-5 text-primary" />
                </div>
              </div>
              
              <div className="glass-panel p-6 relative">
                <div className="absolute -top-4 -left-4 w-10 h-10 rounded-full bg-primary flex items-center justify-center font-bold text-white text-xl">3</div>
                <h3 className="text-xl font-semibold text-white mb-3 mt-2">Evidence Search</h3>
                <p className="text-white/70">
                  Our system searches for supporting evidence from reputable sources to validate claims and conclusions.
                </p>
                <div className="mt-4 flex justify-end">
                  <CheckCircle className="h-5 w-5 text-green-500" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
      
      {/* CTA Section */}
      <section className="py-16 bg-gradient-to-r from-primary-900 to-primary-700">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-3xl font-bold text-white mb-6">
            Ready to verify content with confidence?
          </h2>
          <p className="text-xl text-white/90 mb-8 max-w-2xl mx-auto">
            Start using Civic today to combat misinformation and ensure you're sharing accurate content.
          </p>
          <button className="px-8 py-4 bg-white text-primary-900 hover:bg-white/90 font-medium rounded-lg shadow-lg shadow-primary-900/20 transition-all duration-200 transform hover:translate-y-[-2px]">
            Get Started for Free
          </button>
        </div>
      </section>
    </div>
  );
};

export default HomePage;