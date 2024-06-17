(async () => {
    // importing required modules
    const fetch = (await import('node-fetch')).default;
    const fs = require('fs');
    const yaml = require('js-yaml');

    // parsing command line arguments
    const args = process.argv.slice(2);
    const url = args.find(arg => !arg.startsWith('--'));
    const logFlag = args.includes('--log');
    const conciseFlag = args.includes('--concise');
    const foundFlag = args.includes('--found');
    const saveFlag = args.find(arg => arg.startsWith('--save='));
    const saveFilename = saveFlag ? saveFlag.split('=')[1] : null;

    if (!url) {
        console.log('Please provide a URL as a command line argument');
        process.exit(1);
    }

    console.log('Fetching Linked Art data...');

    const logMessages = new Set();
    const results = {}; 
    
    // function to fetch JSON data from inputted URL
    async function fetchJson(url) {
        try {
            const response = await fetch(url);
    
            if (!response.ok) {
                console.error(`Failed to fetch data from ${url}.`);
                return null;
            }
    
            try {
                return await response.json();
            } catch (jsonError) {
                console.error(`Failed to parse JSON from ${url}.`);
                return null;
            }
        } catch (error) {
            console.error(`Error fetching data from ${url}.`);
            return null;
        }
    }
    
    // function to convert numeric IDs to full URIs (e.g. aat:300312355 -> http://vocab.getty.edu/aat/300312355) and logs this as an issue
    // this was observed in records from the Georgia O'Keeffe Museum (e.g. https://collections.okeeffemuseum.org/data/object/73.json) and numismatics.org (e.g. https://numismatics.org/collection/1935.117.23.jsonld?profile=linkedart)
    function convertToFullUri(id) {
        const patterns = [
            { prefix: 'aat:', baseUri: 'http://vocab.getty.edu/aat/' },
            { prefix: 'tgn:', baseUri: 'http://vocab.getty.edu/tgn/' },
            { prefix: 'ulan:', baseUri: 'http://vocab.getty.edu/ulan/' }
        ];
        for (const pattern of patterns) {
            if (id.startsWith(pattern.prefix)) {
                logMessages.add("Numeric IDs used instead of full URIs.");
                return id.replace(pattern.prefix, pattern.baseUri);
            }
        }
        return id;
    }

    // expands all numeric IDs
    function expandNumericIds(data) {
        function recursiveExpand(obj) {
            if (Array.isArray(obj)) {
                return obj.map(item => recursiveExpand(item));
            } else if (obj && typeof obj === 'object') {
                for (const key in obj) {
                    if (key === 'id' && typeof obj[key] === 'string') {
                        obj[key] = convertToFullUri(obj[key]);
                    } else {
                        obj[key] = recursiveExpand(obj[key]);
                    }
                }
            }
            return obj;
        }
    
        const expandedData = recursiveExpand(data);
        return { expandedData, logMessages };
    }

    // function to retrieve content or value if content is not found; the latter case is logged as an issue
    // the latter was observed in records from the Georgia O'Keeffe Museum; this is a versioning issue
    function getContentOrValue(item, dataField) {
        if (item.content) {
            return item.content;
        } else if (item.value) {
            logMessages.add(`${dataField} could not be retrieved using the "content" attribute. "value" attribute retrieved instead.`);
            return item.value;
        }
        return null;
    }

    // function to perform an iterative search through an object and apply a callback function
    // this is generally useful when processing data fields which are nested differently between Linked Art implementations
    async function iterativeSearch(obj, callback) {
        const queue = [obj];
        while (queue.length > 0) {
            const current = queue.shift();
            if (current && typeof current === 'object') {
                await callback(current);
                if (Array.isArray(current)) {
                    queue.push(...current);
                } else {
                    queue.push(...Object.values(current));
                }
            }
        }
    }    

    // function to identify object classification information
    function findClassifiedAs(obj, targetUris) {
        if (obj && typeof obj === 'object') {
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const result = findClassifiedAs(item, targetUris);
                    if (result) return result;
                }
            } else {
                for (const [key, value] of Object.entries(obj)) {
                    if (typeof value === 'string' && targetUris.includes(value)) return obj;
                    if (key === 'classified_as' || key === 'equivalent') {
                        const result = findClassifiedAs(value, targetUris);
                        if (result) return result;
                    }
                }
            }
        }
        return null;
    }

    // function to find Getty vocabulary URIs within an object, which are generally preferred for retrieving term information in the script
    function findGettyUri(obj) {
        if (obj && typeof obj === 'object') {
            if (Array.isArray(obj)) {
                for (const item of obj) {
                    const foundUri = findGettyUri(item);
                    if (foundUri) return foundUri;
                }
            } else {
                for (const value of Object.values(obj)) {
                    if (typeof value === 'string' && value.includes('vocab.getty.edu')) return value;
                    const foundUri = findGettyUri(value);
                    if (foundUri) return foundUri;
                }
            }
        }
        return null;
    }

    // function to retrieve terms from URIs
    // retrieves the preferred term by default but can also retrieve alternative terms
    // alternative terms often provide useful context in brackets, e.g. "description (activity)" vs. "description" for https://vocab.getty.edu/aat/300080091
    async function getTerm(uri, dataField, termType = 'preferred') {
        try {
            const response = await fetch(uri, {
                headers: {
                    'Accept': 'application/ld+json' // content negotiation to request JSON-LD data
                }
            });
            if (!response.ok) throw new Error(`Invalid URL: ${uri}`);
            const data = await response.json();
            const identifiedBy = data?.identified_by;
            if (Array.isArray(identifiedBy)) {
                for (const item of identifiedBy) {
                    const classifiedAs = item?.classified_as || [];
                    if (termType === 'preferred') {
                        if (classifiedAs.some(ca => ca.id === "http://vocab.getty.edu/aat/300404670")) return item.content;
                        if (classifiedAs.some(ca => ca.equivalent?.some(eq => eq.id === "http://vocab.getty.edu/aat/300404670"))) return item.content;
                    } else {
                        if (classifiedAs.some(ca => ca.id === "http://vocab.getty.edu/aat/300404670")) {
                            const alternativeContent = item?.alternative?.[0]?.content;
                            if (alternativeContent) return alternativeContent;
                        }
                    }
                }
            }
            // when no preferred term is present, returns label content instead, logging this as an issue
            // while this is certainly not ideal practice, this is often the only identifiable approximant to term information in a significant number of records
            // e.g. sets used to associate structured dimensions data in Getty records are formatted as such: https://data.getty.edu/museum/collection/object/0a0fdd7a-8859-4cae-8a5e-8f16ef25a8f6/dimensions/b424c1b2-65e7-552a-90f8-27ad6bbf8cb3/set
            if (termType === 'preferred') {
                const label = data?.label || data?._label;
                if (label) {
                    logMessages.add(`No preferred term found for ${uri}. "${label === data?.label ? 'label' : '_label'}" retrieved instead.`);
                    return label;
                }
            }
            throw new Error(`No ${termType} term found for ${uri}`);
        } catch (error) {
            logMessages.add(`Error retrieving ${dataField} data: ${error.message}`);
            return null;
        }
    }

    // function to identify creator information
    async function creatorPattern(data) {
        async function findCarriedOutBy(obj) {
            const creatorIds = [];
            await iterativeSearch(obj, async item => {
                if (item.carried_out_by) creatorIds.push(item.carried_out_by[0].id);
            });
            return creatorIds;
        }
    
        if (data?.produced_by) {
            const creatorIds = await findCarriedOutBy(data.produced_by);
            const creators = await Promise.all(creatorIds.map(id => getTerm(id, "Creator")));
            results.Creators = creators.filter(Boolean).length > 0 ? creators.filter(Boolean) : ['Not found'];
    
            // prompts the user to verify the data if multiple creators are found, which may indicate more complex record data worth inspecting manually
            if (results.Creators.length > 1) {
                results.CreatorsMessage = 'Multiple creators found. Please verify.';
            }
        } else {
            results.Creators = ['Not found'];
        }
    }    

    // function to handle data following the digital object pattern for linguistic objects, based on https://linked.art/api/1.0/shared/digital/
    async function digitalObjPattern(data, contentTypes) {
        const contentResults = {};
        const seenIds = new Set(); // prevents entry duplication

        contentTypes.forEach(type => {
            contentResults[type.name] = [];
        });

        function checkConformsTo(conformsToArray, target) {
            if (!Array.isArray(conformsToArray)) {
                logMessages.add(`conforms_to is not an array: ${JSON.stringify(conformsToArray)}`);
                return false;
            }
            return conformsToArray.some(conform => conform.id.startsWith(target));
        }        

        function extractContent(digitalObject) {
            if (digitalObject.access_point && digitalObject.access_point.length > 0) {
                return digitalObject.access_point[0].id;
            }
            return digitalObject.id;
        }
        // NB: multiple Linked Art implementations were observed to directly reference digital objects within object ids, rather than inside a digitally_carried_by property
        // the function accommodates this practice but logs it as an issue
        async function collectDigitalObjects(obj, target, typeCheck) {
            const collected = [];
            await iterativeSearch(obj, async obj => {
                if (obj.digitally_carried_by) {
                    for (const digitalObject of obj.digitally_carried_by) {
                        if (typeCheck(digitalObject, target) && !seenIds.has(extractContent(digitalObject))) {
                            collected.push(digitalObject);
                            seenIds.add(extractContent(digitalObject));
                        }
                    }
                } else if (typeCheck(obj, target) && !seenIds.has(extractContent(obj))) {
                    collected.push(obj);
                    seenIds.add(extractContent(obj));
                    logMessages.add(`Digital object ${obj.id} was not embedded in a digitally_carried_by property as expected. "id" retrieved instead. See https://linked.art/api/1.0/shared/digital/ for guidelines.`);
                }
            });
            return collected;
        }

        const webPages = await collectDigitalObjects(data, 'http://vocab.getty.edu/aat/300264578', (obj, target) => {
            return obj.classified_as && findClassifiedAs(obj.classified_as, [target]);
        });
        contentResults['Web Pages'] = webPages.map(extractContent);

        // function first looks for objects which conform to the latest version of the IIIF presentation API, if not then any version
        
        let iiifManifests = await collectDigitalObjects(data, 'http://iiif.io/api/presentation/3/context.json', (obj, target) => {
            return obj.conforms_to && checkConformsTo(obj.conforms_to, target);
        });
        
        if (iiifManifests.length === 0) {
            iiifManifests = await collectDigitalObjects(data, 'http://iiif.io/api/presentation', (obj, target) => {
                return obj.conforms_to && checkConformsTo(obj.conforms_to, target);
            });
        }        

        contentResults['IIIF Manifest'] = iiifManifests.map(extractContent);

        for (const type of contentTypes) {
            results[type.name] = contentResults[type.name].length > 0 ? contentResults[type.name] : ['Not found'];
        }

        return contentResults;
    }

    // function to handle data following the type pattern, based on https://linked.art/api/1.0/shared/type/
    async function typePattern(data) {
        const typeUris = { 'Work Type (Classification)': 'http://vocab.getty.edu/aat/300435443' };
        for (const [key, uri] of Object.entries(typeUris)) {
            const preferredTerms = await Promise.all(
                (data.classified_as || []).map(async item => {
                    if (findClassifiedAs(item, [uri])) {
                        const gettyUri = findGettyUri(item);
                        if (gettyUri) return await getTerm(gettyUri, key);
                    }
                    return null;
                })
            );
            const validTerms = preferredTerms.filter(Boolean);
            results[key] = validTerms.length > 0 ? validTerms : ['Not found'];
        }
    }

    // helper function used within the statement pattern
    function findStatements(data, targetUri, dataField) {
        return (data.referred_to_by || [])
            .filter(item => item.type === 'LinguisticObject' && findClassifiedAs(item.classified_as, [targetUri]))
            .map(item => getContentOrValue(item, dataField))
            .filter(Boolean);
    }

    // helper function used within the materials pattern
    async function findMaterials(data) {
        const materials = await Promise.all(
            (data.made_of || []).map(async material => {
                const materialUri = findGettyUri(material);
                if (materialUri) {
                    return await getTerm(materialUri, 'Materials');
                }
                return null;
            })
        );
        return materials.filter(Boolean).join(', ') || null;
    }

    // helper function used within the dimensions pattern
    // currently this excludes only the "positional attributes" AAT, used in Getty data to enumerate data values but not a physical dimension as such
    // the function could be expanded if other such entries need to be excluded elsewhere however
    function excludeEntry(entry) {
        return entry.classified_as?.some(classification => findGettyUri(classification) === "http://vocab.getty.edu/aat/300010269");
    }
    
    // helper function to retrieve dimension and unit labels from structured data
    async function getDimensionAndUnitLabels(dimension) {
        const dimensionUri = findGettyUri(dimension.classified_as);
        const unitUri = dimension.unit ? findGettyUri(dimension.unit) : null;
    
        const [dimensionLabel, unitLabel] = await Promise.all([
            dimensionUri ? getTerm(dimensionUri, "Dimension") : null,
            unitUri ? getTerm(unitUri, "Unit") : null
        ]);
    
        if (!dimensionLabel) {
            logMessages.add(`Unable to retrieve dimension type from ${dimensionUri || dimension.classified_as.map(item => item.id).join(', ')}`);
        }
    
        if (!unitLabel) {
            logMessages.add(`Unable to retrieve dimension unit from ${unitUri || (dimension.unit ? dimension.unit.id : 'unknown unit')}`);
        }
    
        return { dimensionLabel, unitLabel };
    }    
    
    // Pattern One handles dimensions data in which dimension set information (e.g. "frame", "unframed") is provided using the "member_of" property
    // this is how Getty currently structures their dimensions data
    async function processPatternOne(dimension) {
        const { dimensionLabel, unitLabel } = await getDimensionAndUnitLabels(dimension);
        return dimension.value && dimensionLabel && unitLabel ? `${dimensionLabel}: ${dimension.value} ${unitLabel}` : null;
    }
    
    // Pattern Two handles dimensions data in which the analogous information is instead provided either as an additional classification label...
    // ...referring to a dimension's "assigned_by" property (e.g. https://lux.collections.yale.edu/data/object/d92110b4-3f23-4bd0-b556-0a1659787a2d)...
    // ...or when it is directly associated with the dimension (e.g. https://lux.collections.yale.edu/data/object/4659e968-f94c-4f18-bec7-18de459bd912)
    async function processPatternTwo(dimension) {
        const { dimensionLabel, unitLabel } = await getDimensionAndUnitLabels(dimension);
        let additionalClassLabel = null;
    
        if (dimension.assigned_by && Array.isArray(dimension.assigned_by)) {
            for (const assignment of dimension.assigned_by) {
                if (assignment.classified_as && assignment.classified_as.length > 0) {
                    const additionalUri = assignment.classified_as[0]?.id;
                    additionalClassLabel = additionalUri ? await getTerm(additionalUri, "Additional Classification") : null;
    
                    if (!additionalClassLabel) {
                        logMessages.add(`Unable to retrieve additional classification label from ${additionalUri}`);
                    }
                    break;
                }
            }
        } else if (dimension.classified_as && dimension.classified_as.length > 1) {
            const additionalUri = dimension.classified_as[1]?.id;
            additionalClassLabel = additionalUri ? await getTerm(additionalUri, "Additional Classification") : null;
    
            if (!additionalClassLabel) {
                logMessages.add(`Unable to retrieve additional classification label from ${additionalUri}`);
            }
        }
    
        return dimension.value && dimensionLabel && unitLabel ? { statement: `${dimensionLabel}: ${dimension.value} ${unitLabel}`, additionalClassLabel: additionalClassLabel || '' } : null;
    }
    
    // further helper functions used within the dimensions pattern
    async function processDimension(dimension) {
        if (excludeEntry(dimension)) return null;
    
        if (dimension.member_of && Array.isArray(dimension.member_of)) {
            return await processPatternOne(dimension);
        } else {
            return await processPatternTwo(dimension);
        }
    }
    
    async function findDimensions(data) {
        const dimensionsBySet = {};
        
        if (data.dimension && Array.isArray(data.dimension)) {
            for (const dim of data.dimension) {
                const dimensionsData = await processDimension(dim);
                
                if (dimensionsData) {
                    let setLabel = '';
                    
                    if (typeof dimensionsData === 'string') {
                        for (const member of dim.member_of) {
                            const label = await getTerm(member.id, "Set Label");
                            if (label) {
                                setLabel = label;
                                break;
                            }
                        }
                        if (!dimensionsBySet[setLabel]) dimensionsBySet[setLabel] = [];
                        dimensionsBySet[setLabel].push(dimensionsData);
                    } else {
                        const { statement, additionalClassLabel } = dimensionsData;
                        if (!dimensionsBySet[additionalClassLabel]) dimensionsBySet[additionalClassLabel] = [];
                        dimensionsBySet[additionalClassLabel].push(statement);
                    }
                }
            }
        }
        
        return Object.entries(dimensionsBySet)
            .map(([set, dims]) => `${set ? `${set}: ` : ''}${dims.join('; ')}`)
            .join('\n') || null;
    }    

    // function to handle data following the statement pattern, based on https://linked.art/api/1.0/shared/statement/
    // if a statement is found using a secondary URI, this is processed but logged as an issue...
    // ...as these secondary URIs are generally plausible but possibly non-ideal vocabulary choices
    async function statementPattern(data) {
        const statementUris = {
            // NB: primary and secondary URIs have been populated based on observed use across different implementations but this is only an initial mapping  
            'Credit Line': { primary: 'http://vocab.getty.edu/aat/300435418', secondary: ['http://vocab.getty.edu/aat/300026687'] },
            'Dimensions Statement': { primary: 'http://vocab.getty.edu/aat/300435430', secondary: ['http://vocab.getty.edu/aat/300266036'] },
            'Materials Statement': { primary: 'http://vocab.getty.edu/aat/300435429', secondary: ['http://vocab.getty.edu/aat/300010358'] },
            'Citations': { primary: 'http://vocab.getty.edu/aat/300311705', secondary: [] },
            'Access Statement': { primary: 'http://vocab.getty.edu/aat/300133046', secondary: [] },
            'Description': { primary: 'http://vocab.getty.edu/aat/300435416', secondary: ['http://vocab.getty.edu/aat/300080091'] },
            'Provenance Description': { primary: 'http://vocab.getty.edu/aat/300435438', secondary: ['http://vocab.getty.edu/aat/300055863', 'http://vocab.getty.edu/aat/300444174'] },
            'Work Type (Statement)': { primary: 'http://vocab.getty.edu/aat/300435443', secondary: [] },
            'Social Media': { primary: 'http://vocab.getty.edu/aat/300312269', secondary: [] }
        };

        for (const [key, uris] of Object.entries(statementUris)) {
            let statements = findStatements(data, uris.primary, key);
            if (statements.length === 0 && uris.secondary && uris.secondary.length > 0) {
                for (const secondaryUri of uris.secondary) {
                    statements = findStatements(data, secondaryUri, key);
                    if (statements.length > 0) {
                        const primaryAltTerm = await getTerm(uris.primary, key, 'alternative') || 'Primary Term';
                        const secondaryAltTerm = await getTerm(secondaryUri, key, 'alternative') || 'Secondary Term';
                        logMessages.add(`${key} not found using ${uris.primary} ("${primaryAltTerm}"). ${secondaryUri} ("${secondaryAltTerm}") used instead.`);
                        break;
                    }
                }
            }
            results[key] = statements.length > 0 ? statements : ['Not found'];
        }
    }

    // function to handle structured dimensions data
    async function dimensionsPattern(data) {
        const dimensions = await findDimensions(data);
        results['Dimensions (Structured)'] = dimensions ? dimensions.split('\n') : ['Not found'];
    }

    // function to handle structured materials data
    async function materialsPattern(data) {
        const materials = await findMaterials(data);
        results['Materials (Structured)'] = materials ? [materials] : ['Not found'];
    }

    // helper function used within the identifier and name patterns
    function findItemsByType(data, targetUri, type, dataField) {
        return (data.identified_by || [])
            .filter(item => item.type === type && findClassifiedAs(item.classified_as, [targetUri]))
            .map(item => getContentOrValue(item, dataField))
            .filter(Boolean);
    }

    // function to handle data following the identifier pattern, based on https://linked.art/api/1.0/shared/identifier/
    async function identifierPattern(data) {
        const identifierUris = { 'Accession Number': 'http://vocab.getty.edu/aat/300312355' };
        for (const [key, uri] of Object.entries(identifierUris)) {
            const identifiers = findItemsByType(data, uri, 'Identifier', key);
            results[key] = identifiers.length > 0 ? identifiers : ['Not found'];
        }
    }

    // function to handle data following the name pattern, based on https://linked.art/api/1.0/shared/name/
    async function namePattern(data) {
        const nameUris = {
            'Title': 'http://vocab.getty.edu/aat/300404670',
            'Exhibited Title': 'http://vocab.getty.edu/aat/300417207',
            'Former Title': 'http://vocab.getty.edu/aat/300417203'
        };
        for (const [key, uri] of Object.entries(nameUris)) {
            const names = findItemsByType(data, uri, 'Name', key);
            results[key] = names.length > 0 ? names : ['Not found'];
        }
    }

    // function to parse the date string and extract its components
    function parseDateString(dateString) {
        const regex = /^(-?\d+)-(\d{2})-(\d{2})T/; // regular expression to match date components
        const match = dateString.match(regex);
        if (match) {
            const [, year, month, day] = match;
            return { year: parseInt(year, 10), month: parseInt(month, 10), day: parseInt(day, 10) };
        }
        return null;
    }

    // function to format structured timespan data into reader-friendly text, with negative years formatted as "[year] BC"
    // in Scenario 1, the timespan is given in years (e.g. "1881", "1881 to 1882") if the provided range begins on 1st January and ends on 31st December
    // in Scenario 2, the timespan is given as the month and year (e.g. "January 1881", "January 1881 to June 1882") if the provided range begins on the first day of the month and ends on the last day of the month
    // in Scenario 3, the timespan is given as full dates if the provided range (e.g. "7 January 1881 to 28 June 1882") if neither of the above scenarios apply

    function formatTimespan(beginDate, endDate) {
        const begin = parseDateString(beginDate);
        const end = parseDateString(endDate);

        if (!begin && !end) return null;

        const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
        const isSameYear = begin.year === end.year;
        const isSameMonth = isSameYear && begin.month === end.month;

        // Scenario 1: full year(s) span
        if (begin.month === 1 && begin.day === 1 && end.month === 12 && end.day === 31) {
            return isSameYear ? `${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`}` : `${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`} to ${end.year > 0 ? end.year : `${Math.abs(end.year)} BC`}`;
        }

        // Scenario 2: full month(s) span
        const lastDayOfEndMonth = new Date(end.year, end.month, 0).getDate();
        if (begin.day === 1 && end.day === lastDayOfEndMonth) {
            if (isSameMonth) {
                return `${monthNames[begin.month - 1]} ${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`}`;
            }
            if (isSameYear) {
                return `${monthNames[begin.month - 1]} to ${monthNames[end.month - 1]} ${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`}`;
            }
            return `${monthNames[begin.month - 1]} ${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`} to ${monthNames[end.month - 1]} ${end.year > 0 ? end.year : `${Math.abs(end.year)} BC`}`;
        }

        // Scenario 3: specific dates span
        const beginDateStr = `${begin.day} ${monthNames[begin.month - 1]} ${begin.year > 0 ? begin.year : `${Math.abs(begin.year)} BC`}`;
        const endDateStr = `${end.day} ${monthNames[end.month - 1]} ${end.year > 0 ? end.year : `${Math.abs(end.year)} BC`}`;
        
        return isSameMonth
            ? `${begin.day} to ${endDateStr}`
            : `${beginDateStr} to ${endDateStr}`;
    }

    // function to handle data following the timespan pattern, based on https://linked.art/api/1.0/shared/timespan/
    async function timespanPattern(data) {
        // retrieves the display date if present; note that this has the type Name
        if (data && data.produced_by && data.produced_by.timespan && data.produced_by.timespan.identified_by) {
            const timespanNames = [];
            for (const item of data.produced_by.timespan.identified_by) {
                if (item.type === 'Name') {
                    timespanNames.push(getContentOrValue(item, 'Timespan Display'));
                }
            }
            results['Timespan (Name)'] = timespanNames.length > 0 ? timespanNames : ['Not found'];
        } else {
            results['Timespan (Name)'] = ['Not found'];
        }

        // retrieves structured timespan data if present
        if (data && data.produced_by && data.produced_by.timespan) {
            const timespan = data.produced_by.timespan;
            if (timespan.begin_of_the_begin || timespan.end_of_the_end) {
                const timespanStatement = formatTimespan(timespan.begin_of_the_begin, timespan.end_of_the_end);
                results['Timespan (Structured)'] = timespanStatement ? [timespanStatement] : ['Not found'];
            } else {
                results['Timespan (Structured)'] = ['Not found'];
            }
        } else {
            results['Timespan (Structured)'] = ['Not found'];
        }
    }

    // function to handle data following the reference pattern, based on https://linked.art/api/1.0/shared/reference/
    async function referencePattern(data) {
        const referenceProperties = {
            "current_location": "Location",
            "current_owner": "Owner",
            "member_of": "Set"
        };

        for (const [property, label] of Object.entries(referenceProperties)) {
            if (data[property]) {
                if (Array.isArray(data[property])) {
                    const terms = await Promise.all(data[property].map(async item => {
                        if (item.id) {
                            return await getTerm(item.id, label);
                        }
                        return null;
                    }));

                    const validTerms = terms.filter(term => term);
                    results[label] = validTerms.length > 0 ? validTerms : ['Not found'];
                } else if (data[property].id) {
                    const preferredTerm = await getTerm(data[property].id, label);
                    results[label] = preferredTerm ? [preferredTerm] : ['Not found'];
                }
            } else {
                results[label] = ['Not found'];
            }
        }
    }

    // helper function to update image and thumbnail results
    function updateImageResults(images, thumbnails) {
        results['Primary Image'] = images.length > 0 ? [images[0]] : ['Not found'];
        results['Primary Thumbnail'] = thumbnails.length > 0 ? [thumbnails[0]] : ['Not found'];
        results['All Images'] = images.length > 0 ? images : ['Not found'];
        results['All Thumbnails'] = thumbnails.length > 0 ? thumbnails : ['Not found'];
    }

    // function to extract images and thumbnails from the IIIF manifest retrieved using the digital object pattern
    // the first image and thumbnail retrieved is treated as the primary image/thumbnail, equivalent to the current image/thumbnail functionality... 
    // ...but additionally, subsequent images and thumbnails are also extracted
    async function findImagesAndThumbnails(iiifManifestData) {
        if (!iiifManifestData) {
            updateImageResults([], []);
            return { primaryImage: undefined, primaryThumbnail: undefined, images: [], thumbnails: [] };
        }

        const context = iiifManifestData['@context'];
        let imagesSet = new Set();
        let thumbnailsSet = new Set();

        if (context === 'http://iiif.io/api/presentation/2/context.json') {
            // NB: IIIF manifests may include thumbnails at manifest-level rather than image-level (e.g. https://dams.ashmus.ox.ac.uk/iiif/403683/manifest)...
            // ...hence why the script checks at manifest-level first; storing the data in sets prevents duplication in the event that the same thumbnail...
            // ...is used at both manifest-level and image-level (e.g. https://media.getty.edu/iiif/manifest/db379bba-801c-4650-bc31-3ff2f712eb21)

            // checks for thumbnail data at manifest-level
            const manifestThumbnailUri = iiifManifestData.thumbnail?.['@id'];
            if (manifestThumbnailUri) thumbnailsSet.add(manifestThumbnailUri);
    
            // checks for image and associated thumbnail data
            const canvases = iiifManifestData.sequences?.[0]?.canvases || [];
            for (const canvas of canvases) {
                const imageUris = canvas.images?.map(image => image.resource['@id']).filter(Boolean);
                const thumbnailUri = canvas.thumbnail?.['@id'];
                if (imageUris) imageUris.forEach(uri => imagesSet.add(uri));
                if (thumbnailUri) thumbnailsSet.add(thumbnailUri);
            }
        } else if (context === 'http://iiif.io/api/presentation/3/context.json') {
            // as above, checks for manifest-level thumbnail data first, then image and associated thumbnail data
            const manifestThumbnailUris = iiifManifestData.thumbnail?.map(thumbnail => thumbnail.id).filter(Boolean) || [];
            manifestThumbnailUris.forEach(uri => thumbnailsSet.add(uri));

            const items = iiifManifestData.items || [];
            for (const item of items) {
                const imageUris = item.items?.flatMap(subItem => subItem.items?.map(subSubItem => subSubItem.body?.id).filter(Boolean)) || [];
                const thumbnailUris = item.thumbnail?.map(thumbnail => thumbnail.id).filter(Boolean) || [];
                imageUris.forEach(uri => imagesSet.add(uri));
                thumbnailUris.forEach(uri => thumbnailsSet.add(uri));
            }
        }

        const images = Array.from(imagesSet);
        const thumbnails = Array.from(thumbnailsSet);
        updateImageResults(images, thumbnails);

        return {
            primaryImage: images[0],
            primaryThumbnail: thumbnails[0],
            images,
            thumbnails
        };
    }

    // function to process IIIF manifests and update results
    async function iiifPattern(results) {
        const iiifManifests = results['IIIF Manifest'];
        if (iiifManifests.length === 0) {
            updateImageResults([], []);
            return;
        }

        const manifestUrl = iiifManifests[0];
        const iiifData = await fetchJson(manifestUrl);
        if (!iiifData) {
            logMessages.add(`Failed to fetch IIIF Manifest data from ${manifestUrl}`);
            updateImageResults([], []);
            return;
        }
        await findImagesAndThumbnails(iiifData);
    }

    // main function to consolidate the above functions
    async function runAllPatterns(url) {
        const data = await fetchJson(url);
        if (!data) {
            return;
        }

        const { expandedData, logMessages: expandLogMessages } = expandNumericIds(data);

        expandLogMessages.forEach(message => {
            logMessages.add(message);
        });

        const contentTypes = [
            { name: 'Web Pages', classified_as: 'http://vocab.getty.edu/aat/300264578' },
            {
                name: 'IIIF Manifest',
                conforms_to: { primary: 'http://iiif.io/api/presentation/3/context.json', secondary: 'http://iiif.io/api/presentation' }
            }
        ];

        await namePattern(expandedData);
        await identifierPattern(expandedData);
        await typePattern(expandedData);
        await creatorPattern(expandedData);
        await timespanPattern(expandedData);
        await dimensionsPattern(expandedData);
        await materialsPattern(expandedData);
        await referencePattern(expandedData);
        await statementPattern(expandedData);
        const digitalObjResults = await digitalObjPattern(expandedData, contentTypes);
        await iiifPattern(digitalObjResults);

        outputResults();

        if (logMessages.size > 0) {
            if (!logFlag) {
                console.log(`${logMessages.size} issue(s) logged. To view these messages, include the --log argument when running the script.`);
            } else {
                console.log(`${logMessages.size} issue(s) logged.`);
            }
        }
    }

    // allows results order to be configured in various ways
    function outputResults() {
        const outputOrder = [
            'Title',
            'Exhibited Title',
            'Former Title',
            'Accession Number',
            'Creators',
            // when the --concise argument is used, only one form of the work type, timespan, dimensions, and materials information is outputted
            { primary: 'Work Type (Classification)', secondary: 'Work Type (Statement)' },
            { primary: 'Timespan (Name)', secondary: 'Timespan (Structured)' },
            { primary: 'Dimensions Statement', secondary: 'Dimensions (Structured)' },
            { primary: 'Materials Statement', secondary: 'Materials (Structured)' },
            'Location',
            'Owner',
            'Set',
            'Social Media',
            'Credit Line',
            'Citations',
            'Access Statement',
            'Description',
            'Provenance Description',
            'Web Pages',
            'IIIF Manifest',
            'Primary Image',
            'Primary Thumbnail',
            'All Images',
            'All Thumbnails'
        ];
    
        const output = {};
    
        console.log('Consolidated Results:');
        outputOrder.forEach(entry => {
            if (typeof entry === 'string') {
                if (entry === 'Creators' && results.CreatorsMessage) {
                    console.log(results.CreatorsMessage); // print the message about multiple creators if necessary
                }
                if (foundFlag && results[entry]?.[0] === 'Not found') return; // skip not found entries if --found argument is used
                console.log(`${entry}:`);
                if (results[entry]) {
                    results[entry].forEach(item => console.log(`- ${item}`));
                    output[entry] = results[entry];
                } else {
                    console.log('Not found');
                    output[entry] = ['Not found'];
                }
            } else {
                const { primary, secondary } = entry;
                // consolidates corresponding fields if the --concise argument is used
                // in each case, the 'primary' form of the data is prioritised over the 'secondary' form 
                if (conciseFlag) {
                    const conciseLabel = primary.split(' (')[0]; // removes bracketed info (e.g. "Work Type (Classification)" -> "Work Type" for readability
                    if (results[primary] && results[primary][0] !== 'Not found') {
                        if (foundFlag && results[primary][0] === 'Not found') return;
                        console.log(`${conciseLabel}:`);
                        results[primary].forEach(item => console.log(`- ${item}`));
                        output[conciseLabel] = results[primary];
                    } else if (results[secondary]) {
                        if (foundFlag && results[secondary][0] === 'Not found') return;
                        console.log(`${conciseLabel}:`);
                        results[secondary].forEach(item => console.log(`- ${item}`));
                        output[conciseLabel] = results[secondary];
                    } else {
                        console.log(`${conciseLabel}: Not found`);
                        output[conciseLabel] = ['Not found'];
                    }
                } else {
                    if (results[primary]) {
                        if (foundFlag && results[primary][0] === 'Not found') return;
                        console.log(`${primary}:`);
                        results[primary].forEach(item => console.log(`- ${item}`));
                        output[primary] = results[primary];
                    }
                    if (results[secondary]) {
                        if (foundFlag && results[secondary][0] === 'Not found') return;
                        console.log(`${secondary}:`);
                        results[secondary].forEach(item => console.log(`- ${item}`));
                        output[secondary] = results[secondary];
                    }
                }
            }
        });
    
        // outputs log messages if the --log argument is used
        if (logFlag) {
            console.log('Log Messages:');
            const logArray = Array.from(logMessages);
            logArray.forEach(message => console.log(`- ${message}`));
            output['Log Messages'] = logArray;
        }
    
        // saves the output to a file if the --save argument is used
        if (saveFilename) {
            try {
                const yamlStr = yaml.dump(output);
                fs.writeFileSync(saveFilename, yamlStr, 'utf8');
                console.log(`Results saved to ${saveFilename}`);
            } catch (error) {
                console.error(`Failed to save results to ${saveFilename}: ${error.message}`);
            }
        }
    }
        
    if (url) {
        runAllPatterns(url);
    } else {
        console.log('Please provide a URL as a command line argument');
    }
})();   