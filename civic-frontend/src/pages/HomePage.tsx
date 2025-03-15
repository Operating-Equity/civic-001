import React, { useState } from 'react';
import { Shield, CheckCircle, Search, ArrowRight } from 'lucide-react';
import VideoInput from '../components/video/VideoInput';
import VideoThumbnail from '../components/video/VideoThumbnail';
import TranscriptDisplay from '../components/video/TranscriptDisplay';
import Summary from '../components/analysis/Summary';
import ClaimEvaluator from '../components/analysis/ClaimEvaluator';
import KeywordGeneration from '../components/search/KeywordGeneration';
import EvidenceResults from '../components/search/EvidenceResults';
import { useVideoAnalysis } from '../hooks/useVideoAnalysis';
import { useEvidenceSearch } from '../hooks/useEvidenceSearch';

const HomePage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<'analysis' | 'evidence'>('analysis');
  
  const {
    transcript,
    thumbnailUrl,
    summary,
    videoTitle,
    empiricalClaims,
    isLoading,
    error,
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

  return (
    <div className="min-h-screen">
      {/* Simplified Hero Section - Light Theme */}
      <section className="relative py-16 bg-white">
        <div className="container mx-auto px-4 relative z-10">
          <div className="text-center max-w-2xl mx-auto mb-8">
            <div className="flex justify-center mb-6">
              <div className="p-3 bg-blue-100 rounded-full">
                <Shield className="h-12 w-12 text-blue-600" />
              </div>
            </div>
            
            <h1 className="text-3xl md:text-4xl font-bold text-gray-900 mb-4 tracking-tight">
              The Video Truth Standard
            </h1>
            
            <p className="text-lg text-gray-600 mb-6">
              Civic analyzes videos with multi-model AI verification, adding a layer of credibility with objective fact-checking you can trust.
            </p>
          </div>
        </div>
      </section>
      
      {/* Video Analysis Section - Light Theme */}
      <section id="analysis" className="py-8 bg-gray-50">
        <div className="container mx-auto px-4">
          <div className="max-w-3xl mx-auto">
            <div className="mb-8 text-center">
              <h2 className="text-2xl font-bold text-gray-900">
                Verify a Video
              </h2>
              <p className="text-gray-600 mt-2">
                Enter a YouTube URL or upload a video to start the verification process
              </p>
            </div>
            
            <VideoInput onVideoSubmit={handleVideoSubmit} isProcessing={isLoading} error={error} />
            
            {isLoading && (
              <div className="mt-8 glass-panel p-8 flex flex-col items-center justify-center">
                <div className="animate-spin h-10 w-10 border-3 border-blue-600 border-t-transparent rounded-full mb-4"></div>
                <p className="text-lg font-medium text-gray-800">Analyzing for Factual Accuracy</p>
                <p className="text-gray-600 mt-2">Our AI models are verifying claims in your video</p>
              </div>
            )}
          </div>
        </div>
      </section>
      
      {/* Trust Indicators - Light Theme */}
      <section className="py-12 bg-white">
        <div className="container mx-auto px-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 max-w-3xl mx-auto">
            <div className="flex flex-col items-center text-center px-4 py-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                <CheckCircle className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Multi-Model Verification</h3>
              <p className="text-gray-600 text-sm">Cross-checking claims using OpenAI, Anthropic, and Perplexity for balanced analysis</p>
            </div>
            
            <div className="flex flex-col items-center text-center px-4 py-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                <Search className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Evidence-Based Results</h3>
              <p className="text-gray-600 text-sm">Automatic search for supporting sources to back every verification decision</p>
            </div>
            
            <div className="flex flex-col items-center text-center px-4 py-6">
              <div className="flex items-center justify-center w-12 h-12 rounded-full bg-blue-100 mb-4">
                <Shield className="h-6 w-6 text-blue-600" />
              </div>
              <h3 className="text-lg font-semibold text-gray-900 mb-2">Verification Confidence</h3>
              <p className="text-gray-600 text-sm">Clear confidence scores and supporting evidence for transparent verification</p>
            </div>
          </div>
        </div>
      </section>
      
      {/* Results Section (conditionally rendered) - Light Theme */}
      {hasResults && (
        <section className="py-12 bg-gray-50">
          <div className="container mx-auto px-4">
            <div className="max-w-4xl mx-auto">
              <div className="text-center mb-8">
                <h2 className="text-2xl font-bold text-gray-900">Verification Results</h2>
                <p className="text-gray-600 mt-2">
                  {videoTitle ? `Analysis for: ${videoTitle}` : 'Video analysis complete'}
                </p>
              </div>
            
              <div className="mb-8 flex justify-center gap-4">
                <button
                  className={`px-5 py-2 rounded-full font-medium transition-colors flex items-center
                    ${activeSection === 'analysis' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                  onClick={() => setActiveSection('analysis')}
                >
                  <CheckCircle className="h-4 w-4 mr-2" />
                  <span>Fact Verification</span>
                </button>
                
                <button
                  className={`px-5 py-2 rounded-full font-medium transition-colors flex items-center
                    ${activeSection === 'evidence' ? 'bg-blue-600 text-white' : 'bg-gray-200 text-gray-700 hover:bg-gray-300'}`}
                  onClick={() => setActiveSection('evidence')}
                >
                  <Search className="h-4 w-4 mr-2" />
                  <span>Evidence</span>
                </button>
              </div>
              
              {/* Video Thumbnail */}
              <VideoThumbnail thumbnailUrl={thumbnailUrl} videoTitle={videoTitle} />
              
              {activeSection === 'analysis' ? (
                <>
                  {/* Analysis Results */}
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mt-6">
                    <Summary summary={summary} videoTitle={videoTitle} />
                    <TranscriptDisplay transcript={transcript} />
                  </div>
                  
                  <div className="mt-8">
                    <ClaimEvaluator empiricalClaims={empiricalClaims} />
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
      
      {/* Simple CTA Section - Light Theme */}
      <section className="py-14 bg-blue-600">
        <div className="container mx-auto px-4 text-center">
          <h2 className="text-2xl font-bold text-white mb-4">
            Add credibility to your content
          </h2>
          <p className="text-lg text-white/90 mb-6 max-w-xl mx-auto">
            Join content creators and organizations using Civic to verify their videos before sharing.
          </p>
          <button className="px-6 py-3 bg-white text-blue-600 hover:bg-gray-100 font-medium rounded-lg shadow transition-all">
            Get Started
          </button>
        </div>
      </section>
    </div>
  );
};

export default HomePage;