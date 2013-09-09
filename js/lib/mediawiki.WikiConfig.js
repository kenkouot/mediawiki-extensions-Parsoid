/*
 * Per-wiki config library for interfacing with MediaWiki.
 */

var baseConfig = require( './baseconfig/en.json' ).query,
	JSUtils = require('./jsutils.js').JSUtils,
	Util = require( './mediawiki.Util.js' ).Util,
	request = require( 'request' );

// Make sure our base config is never modified
JSUtils.deepFreeze(baseConfig);

// escape 'special' characters in a regexp, returning a regexp which matches
// the string exactly
var re_escape = function(s) {
	return s.replace(/[\^\\$*+?.()|{}\[\]]/g, '\\$&');
};

/**
 * @class
 *
 * Per-wiki configuration object.
 *
 * @constructor
 * @param {Object} resultConf The configuration object from a MediaWiki API request. See the #ConfigRequest class in lib/mediawiki.ApiRequest.js for information about how we get this object. If null, we use the contents of lib/mediawiki.BaseConfig.json instead.
 * @param {string} prefix The interwiki prefix this config will represent. Will be used for caching elsewhere in the code.
 * @param {string} uri The URI that represents this wiki's API endpoint. Usually ends in api.php.
 */
function WikiConfig( resultConf, prefix, uri ) {
	var nsid,
		name;


	// Mapping from canonical namespace name to id
	// The English namespace names are built-in and will work in any language.
	this.canonicalNamespaces = {
		media: -2,
		special: -1,
		main: 0,
		'': 0,
		talk: 1,
		user: 2,
		user_talk: 3,
		project: 4,
		project_talk: 5,
		file: 6,
		image: 6,
		file_talk: 7,
		image_talk: 7,
		mediawiki: 8,
		mediawiki_talk: 9,
		template: 10,
		template_talk: 11,
		help: 12,
		help_talk: 13,
		category: 14,
		category_talk: 15
	};
	// Seed localized namespace name to id mapping with canonicalNamespaces
	this.namespaceIds = Object.create(this.canonicalNamespaces);

	// The interwiki prefix
	this.iwp = prefix;

	// The URI for api.php on this wiki.
	this.apiURI = uri || null;

	if ( resultConf === null ) {
		// Use the default JSON that we've already loaded above.
		resultConf = baseConfig;
	}
	var general = resultConf.general;

	// The language
	this.lang = general.lang;

	var names = resultConf.namespaces;
	var nkeys = Object.keys( names );

	// Mapping from namespace id to the canonical name. Start with defaults.
	this.namespaceNames = {
		'6': 'File',
		'-2': 'Media',
		'-1': 'Special',
		'0': '',
		'14': 'Category'
	};

	// Namespace IDs that have subpages enabled.
	this.namespacesWithSubpages = {};
	for ( var nx = 0; nx < nkeys.length; nx++ ) {
		nsid = nkeys[nx];
		name = names[nsid];
		this.namespaceNames[nsid] = name['*'];
		this.namespaceIds[name['*'].toLowerCase().replace(' ', '_')] = Number( nsid );
		if ( name.canonical ) {
			// XXX: is this b/c?
			this.canonicalNamespaces[name.canonical.toLowerCase().replace(' ', '_')] =
				Number( nsid );
		} else {
			this.canonicalNamespaces[name['*'].toLowerCase().replace(' ', '_')] =
				Number( nsid );
		}
		if ( 'subpages' in names[nsid] ) {
			this.namespacesWithSubpages[ Number( nsid ) ] = true;
		}
	}

	// add in a parsoid pseudo-namespace


	var aliases = resultConf.namespacealiases;
	for ( var ax = 0; ax < aliases.length; ax++ ) {
		this.namespaceIds[aliases[ax]['*'].toLowerCase().replace(' ', '_')] = aliases[ax].id;
	}

	// The interwikiMap maps prefixes to the corresponding information
	// gathered from the api query (prefix, language, url, local)
	this.interwikiMap = {};
	var interwikimap = resultConf.interwikimap;
	var interwikiKeys = Object.keys(interwikimap);
	for ( var index = 0; index < interwikiKeys.length; index++ ) {
		var key = interwikimap[index].prefix;
		this.interwikiMap[key] = interwikimap[index];
	}


	// Add in wikipedia languages too- they are not necessarily registered as
	// interwikis and are expected by parserTests.
	for ( var i = 0, l = resultConf.languages.length; i < l; i++ ) {
		var entry = resultConf.languages[i];
		if (!this.interwikiMap[entry.code]) {
			this.interwikiMap[entry.code] = {
				prefix: entry.code,
				url: 'http://' + entry.code + '.wikipedia.org/wiki/$1',
				language: entry['*']
			};
		} else if (!this.interwikiMap[entry.code].language) {
			// Not sure if this case is possible, but make sure this is
			// treated as a language.
			this.interwikiMap[entry.code].language = entry['*'];
		}
	}

	// "mw" here refers to "magicwords", not "mediawiki"
	var mws = resultConf.magicwords;
	var mw, replaceRegex = /\$1/;
	var namedMagicOptions = [];

	// Canonical magic word names on this wiki, indexed by aliases.
	this.magicWords = {};

	// Lists of aliases, indexed by canonical magic word name.
	this.mwAliases = {};

	// RegExps matching aliases, indexed by canonical magic word name.
	this._mwRegexps = {};

	// List of magic words that are interpolated, i.e., they have $1 in their aliases.
	this._interpolatedMagicWords = [];

	// List of magic word aliases with $1 in their names, indexed by canonical name.
	this._interpolatedMagicWordAliases = {};

	for ( var mwx = 0; mwx < mws.length; mwx++ ) {
		mw = mws[mwx];
		aliases = mw.aliases;
		if ( aliases.length > 0 ) {
			this.mwAliases[mw.name] = [];
			this._interpolatedMagicWordAliases[mw.name] = [];
		}
		for ( var mwax = 0; mwax < aliases.length; mwax++ ) {
			var alias = aliases[mwax];
			if ( mw['case-sensitive'] !== '' ) {
				alias = alias.toLowerCase();
			}

			if ( alias.match( /\$1/ ) !== null ) {
				// This is a named option. Add it to the array.
				namedMagicOptions.push( alias.replace( replaceRegex, '(.*)' ) );
				this._interpolatedMagicWords.push( alias );
				this._interpolatedMagicWordAliases[mw.name].push( alias );
			}
			this.magicWords[alias] = mw.name;
			this.mwAliases[mw.name].push( alias );
		}
		this._mwRegexps[mw.name] =
			new RegExp( '^(' +
			            this.mwAliases[mw.name].map(re_escape).join('|') +
			            ')$',
			            mw['case-sensitive'] === '' ? '' : 'i' );
	}

	if ( mws.length > 0 ) {
		// Combine the gathered named magic words into a single regex
		var namedMagicString = namedMagicOptions.join( '|' );
		this.namedMagicRegex = new RegExp( namedMagicString );
	}

	// Special page names on this wiki, indexed by aliases.
	this.specialPages = {};
	// This path isn't necessary because we don't need special page aliases.
	// Before you uncomment this, make sure you actually need it, and be sure to
	// also add 'specialpagealiases' back into the API request for the config.
	//	var specials = resultConf.specialpagealiases;
	//	for ( var sx = 0; sx < specials.length; sx++ ) {
	//		aliases = specials[sx].aliases;
	//		for ( var sax = 0; sax < aliases.length; sax++ ) {
	//			this.specialPages[aliases[sax]] = specials[sx].realname;
	//		}
	//	}

	// Regex for stripping useless stuff out of the regex messages
	var stripRegex = /^\/\^(.*)\$\//;

	// Helper function for parsing the linktrail/linkprefix regexes
	function buildLinkNeighbourRegex( string, isTrail ) {
		var regexResult = string.match( stripRegex );

		if ( regexResult !== null ) {
			regexResult = regexResult[1].replace( /\(\.\*\??\)/, '' );
		}

		if (regexResult === '()') {
			// At least zh gives us a linktrail value of /^()(.*)$/sD, which
			// would match anything. Refuse to use such a non-sense regexp.
			return null;
		}

		if ( isTrail ) {
			regexResult = '^' + regexResult;
		} else {
			regexResult += '$';
		}

		try {
			//console.warn('new regexp for ' + prefix + ': ' + regexResult);
			return new RegExp( regexResult );
		} catch (e) {
			console.error(e);
			return null;
		}
	}

	// Get the general information and use it for article, upload, and image
	// paths.
	if ( resultConf.general ) {
		if ( general.articlepath ) {
			if ( general.server ) {
				this.baseURI = general.server + general.articlepath.replace(/\$1/, '');
			}

			this.articlePath = general.articlepath;
		}

		if ( general.script ) {
			this.script = general.script;
		}

		if ( general.server ) {
			this.server = general.server;
		}

		if ( general.linktrail ) {
			this.linkTrailRegex = buildLinkNeighbourRegex( general.linktrail, true );
		} else if ( general.linktrail === '' ) {
			this.linkTrailRegex = null;
		} else {
			this.linkTrailRegex = Util.linkTrailRegex;
		}

		if ( general.linkprefix ) {
			this.linkPrefixRegex = buildLinkNeighbourRegex( general.linkprefix, false );
		} else {
			this.linkPrefixRegex = null;
		}

		if ( general['case'] === 'case-sensitive' ) {
			this.caseSensitive = true;
		} else {
			this.caseSensitive = false;
		}

		if ( general.externalimages ) {
			this.allowExternalImages = general.externalimages;
		}

		if ( general.imagewhitelistenabled !== undefined ) {
			this.enableImageWhitelist = true;
			// XXX we don't actually support the on-wiki whitelist (bug 51268)
			// if we did, we would probably want to fetch and cache
			//  MediaWiki:External image whitelist
			// here (rather than do so on every parse)
		} else {
			this.enableImageWhitelist = false;
		}
	}

	if ( !this.baseURI ) {
		throw new Error( 'No baseURI was provided by the config request we made.' );
	}

	// Allowed protocol prefixes
	this._protocols = {};
	// Get information about the allowed protocols for external links.
	if ( resultConf.protocols ) {
		var proto, protocols = resultConf.protocols;
		for ( var px = 0; px < protocols.length; px++ ) {
			proto = protocols[px];
			this._protocols[proto] = true;
		}

		this._protocolRegex = new RegExp( '^(' + protocols.join( '|' ) + ')', 'i' );
	}

	// Extension tags on this wiki, indexed by their aliases.
	this.extensionTags = {};
	if ( resultConf.extensiontags ) {
		var ext, extensions = resultConf.extensiontags;
		for ( var ex = 0; ex < extensions.length; ex++ ) {
			ext = extensions[ex];
			// Strip the tag wrappers because we only want the name
			this.extensionTags[ext.replace( /(^<|>$)/g, '' ).toLowerCase()] = true;
		}
	}

	// Function hooks on this wiki, indexed by their normalized form
	this.functionHooks = JSUtils.arrayToHash(resultConf.functionhooks || []);
}


/**
 * @method
 *
 * Get the canonical name of a magic word alias.
 *
 * @param {string} alias
 * @returns {string}
 */
WikiConfig.prototype.getMagicWordIdFromAlias = function ( alias ) {
	return this.magicWords[alias] || null;
};

/**
 * @method
 *
 * Get a regexp matching a localized magic word, given its id.
 *
 * @param {string} id
 * @return {RegExp}
 */
WikiConfig.prototype.getMagicWordMatcher = function ( id ) {
	// if 'id' is not found, return a regexp which will never match.
	return this._mwRegexps[id] || /[]/;
};

/**
 * @method
 *
 * Get a matcher function for fetching values out of interpolated magic words, i.e. those with $1 in their aliases.
 *
 * @param {string} optionsList The list of options you want to check for (e.g. the list of all interpolated image options)
 * @returns {Function}
 */
WikiConfig.prototype.getMagicPatternMatcher = function ( optionsList ) {
	var ix, mwlist, aliases, regex, regexString = '',
		getInterpolatedMagicWord = function ( text, useRegex, useMwList ) {
			var ix, alias, value, canonical,
			matches = text.match( useRegex );
			useMwList = useMwList || this._interpolatedMagicWords;
			useRegex = useRegex || this.namedMagicRegex;

			if ( matches === null ) {
				return null;
			}
			alias = null;
			for ( ix = 1; ix < matches.length && ix - 1 < useMwList.length && alias === null; ix++ ) {
				if ( matches[ix] !== undefined ) {
					alias = useMwList[ix - 1];
					value = matches[ix];
				}
			}
			if ( alias === null ) {
				return null;
			}
			canonical = this.getMagicWordIdFromAlias( alias );
			if ( canonical !== null ) {
				return { k: canonical, v: value, a: alias };
			}
			return null;
		}.bind( this );


	mwlist = [];
	for ( ix = 0; ix < optionsList.length; ix++ ) {
		if ( ix > 0 ) {
			regexString += '|';
		}
		if ( aliases = this._interpolatedMagicWordAliases[optionsList[ix]] ) {
			regexString += aliases.join( '|' )
				.replace( /((?:^|\|)(?:[^\$]|\$[^1])*)($|\|)/g, '$1$$1$2' )
				.replace( /\$1/g, '(.*)' );
			mwlist = mwlist.concat( aliases );
		}
	}
	console.log("regexString", regexString);
	regex = new RegExp( regexString );

	return function ( text ) {
		return getInterpolatedMagicWord( text, regex, mwlist );
	};
};

/**
 * @method
 *
 * Builds a magic word string out of an alias with $1 in it and a value for the option.
 *
 * @param {string} alias
 * @param {string} value
 * @returns {string}
 */
WikiConfig.prototype.replaceInterpolatedMagicWord = function ( alias, value ) {
	return alias.replace( /\$1/, value );
};

/**
 * @param {string} potentialLink
 */
WikiConfig.prototype.hasValidProtocol = function ( potentialLink ) {
	if ( this._protocolRegex ) {
		return this._protocolRegex.test( potentialLink );
	} else {
		// With no available restrictions, we have to assume "no".
		return false;
	}
};

/**
 * @param {string} potentialTag in lower case
 */
WikiConfig.prototype.isExtensionTag = function ( potentialTag ) {
	if ( this.extensionTags === null ) {
		return false;
	} else {
		return this.extensionTags[potentialTag.toLowerCase()] === true;
	}
};

/**
 * @param {string} newTag
 */
WikiConfig.prototype.addExtensionTag = function ( newTag ) {
	this.extensionTags[newTag] = true;
};

/**
 * @param {string} tagName
 */
WikiConfig.prototype.removeExtensionTag = function ( tagName ) {
	delete this.extensionTags[tagName];
};

if ( typeof module === 'object' ) {
	module.exports.WikiConfig = WikiConfig;
}
