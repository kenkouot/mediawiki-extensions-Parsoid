#include "parsoid_internal.hpp"

namespace parsoid {

Parsoid::Parsoid ()
    : mainInputExpansionPipeline( InputExpansionPipeline( true ) )
{
    // Create a new environment per request

    // Create the output pipeline
    // TODO: pass in environment
    syncOutputPipeline = OutputPipeline();

    // Hook up the output pipeline to the input pipeline
    mainInputExpansionPipeline.setReceiver(
        bind( &OutputPipeline::receive, &syncOutputPipeline, _1 )
    );
}

void assign( DOM::XMLDocument** target, DOM::XMLDocument* value ) { *target = value; }

DOM::XMLDocument* Parsoid::parse( string input ) {
    DOM::XMLDocument* doc;
    // define a callback that appends to string
    // TODO: actually handle TokenMessage in callback!
    auto cb = bind( assign, &doc, _1 );
    parse( input, cb );
    return doc;
}

void Parsoid::parse( string input, DOM::DocumentReceiver receiver ) {
    // Set the syncOutputPipeline receiver
    syncOutputPipeline.setReceiver( receiver );

    // Feed the input pipeline
    mainInputExpansionPipeline.receive( input );
}


}
