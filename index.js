/* 
	PDF Builder, 
	Takes a Document Object & TenantToDocument Array (with signature objects populated) & returns built PDF
*/

/*
-Populate pdf form fields with xfdf file
-convert all signature dataurl to png
-convert all signature png to pdf
-scale up and offset signature onto a4paper 
-stamp all signature pdfs onto the xfdf built pdf
*/
//const { createCanvas, loadImage } = require('canvas');
var Canvas = require('canvas')
  , Image = Canvas.Image;
const moment = require('moment');

const xfdf = require('xfdf');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const xfdfBuild = new xfdf();
const DocumentController = require(path.resolve('api/document/document-controller'));
const FormController = require(path.resolve('api/form/form-controller'));
const TenantToDocumentController = require(path.resolve('api/tenant-to-document/tenant-to-document-controller'));
const DocumentEventController = require(path.resolve('api/document-event/document-event-controller'));

const blankpdf = 'public/uploads/blank.pdf';
const uploadPath = 'public/user-forms';

module.exports = {
	download: (doc) => {
		let docEvents, form;
		return (
			FormController.read(doc.form)
			.then(f => {
				form = f;
				return DocumentEventController.findForDocument(doc._id);
			})
			.then(de => {
				docEvents = de;
				let buildRequired = true;
				if (doc.lastBuild) {
					buildRequired = doc.lastBuild < doc.lastUpdate;
					docEvents.forEach(evt => {
						if (evt.updatedFields && evt.updatedFields.length > 0 && evt.createdDate > doc.lastBuild) {
							buildRequired = true;
						}
					});
				}
				if (buildRequired) {
					return createPdf(form, doc, docEvents)
				} else {
	 				/* TODO: FIGURE OUT A FUNCTION TO GENERATE FINAL FILPEATH*/				
					return getPrettyFilepath(form, doc) //figure out filepath that it gets written too based on doc/owner_Id stuff
				}
			})
			.catch(err => {
				console.log(err);
				return err;
			})
		);
	}
}
function createPdf(form, doc, docEvents) {
	return buildPdf(form, doc, docEvents)
	.then(pdfFileLocation => {
		// update lastBuild field
		doc.lastBuild = moment().valueOf();
		DocumentController.update(doc);
		return pdfFileLocation;//res.sendFile(path.resolve(pdfFileLocation));
	}).catch(err => { return {status:400, message:err} });
}

function getPrettyFilepath(form, doc) {
	return `${uploadPath}/${doc.owner}/${form.name.split(' ').join('_')}_${doc._id}.pdf`;
}
/* TODO LAYER DOCEVENTS INTO BUILD STUFF,*/
function buildPdf(form, doc, docEvents) {
	return new Promise( (resolve, reject) => {
		if (doc.fields.length) {
			let formFields = JSON.parse(form.fields);
			let docFields  = JSON.parse(doc.fields);
			// layer in event fields
			docEvents.sort((a,b) =>  a.createdDate - b.createdDate);
			docEvents.forEach(evt => {
				if (evt.updatedFields && evt.updatedFields.length > 0) {
					let fields = JSON.parse(evt.updatedFields);
					for (let x in fields) {
						docFields[x] = fields[x];
					}
				}
			});

			let xfdfJSON = {fields: extractTextFields(docFields, formFields)};
			let signatureJSON = extractSignatureFields(docFields, formFields);

			// mkdir for pdf and write to there done do
			fs.mkdir(`${uploadPath}/${doc.owner}`, (err, success) => {
				if (err && err.code !== "EEXIST") {
					throw err;
				}
				let xfdfPdf = false;
				let signaturePdfs = false;
				
				writeXfdfToPdf(form, doc, xfdfJSON)
				.then((pdf) => {
					xfdfPdf = pdf;
					return writeSignaturesToPdf(form, doc, signatureJSON);
				})
				.then((pdfs) => {
					signaturePdfs = pdfs;
					if (xfdfPdf && signaturePdfs) {
						return addSignatureStamps(xfdfPdf, signaturePdfs);
					} else {
						throw 'somethin wrong:' + xfdfPdf + signaturePdfs.join(':');
					}
				})
				.then((builtFileLocation) => {
					if (builtFileLocation) {
						let prettyFilepath = getPrettyFilepath(form, doc);
						fs.rename(builtFileLocation, prettyFilepath, (err, success) => {
							if (err) {
								console.log(err);
								cleanupTempFiles(`temp/${doc._id}.xfdf`, signaturePdfs);
								throw err;
							} else {
								cleanupTempFiles(`temp/${doc._id}.xfdf`, signaturePdfs);
								return resolve(prettyFilepath);
							}
						});
					} else {
						throw 'builtFileLocation missing';
					}
				})
				.catch(err => {
					console.error(err);
					return reject(err);
				});

			});
		// just return the raw document
		} else {
			return resolve(form.pdf);
		}
	});
}


function extractTextFields(docFields, formFields) {
	let validFields = {};
	for (var x in formFields) {
		if (formFields[x].type !== 'signature') {
			if (docFields[x]){
				validFields[x] = docFields[x];
			}
		}
	}
	return validFields;
}

function extractSignatureFields(docFields, formFields) {
	let validFields = {};
	for (var x in formFields) {
		if (formFields[x].type === 'signature') {
			if (docFields[x]) {
				validFields[x] = {
					data:docFields[x],
					page: formFields[x].page || 0,
					offsetX: formFields[x].offsetX || '+0cm',
					offsetY: formFields[x].offsetY || '+0cm',
				}
			}
		}
	}
	return validFields;
}

// pdftk public/uploads/erd/erd.pdf stamp /Users/ericmcelyea/Documents/union5/public/uploads/Erd/5aa9c025a017db23ec77cbfa_signature_owner-pdfjam.pdf output final.pdf
// pdftk original.pdf multistamp multistamp.pdf output final.pdf

/* ######## ADD SIGNATURE STAMPS TO PDF ######## */
function addSignatureStamps(xfdf, signatureStamps) {
	return new Promise( (resolve, reject) => {
		let stampArray = [];
		for (let x in signatureStamps) {
			stampArray.push(signatureStamps[x].finalStampFile);
		}
		addAllSignatures(xfdf, stampArray, (err, finalPdf) => {
			if (err) {
				return reject(err);
			} else {
				return resolve (finalPdf);
			}
		});
	});
}
// executes synchronous & recursive, each stamp applied after the previous
function addAllSignatures(xfdf, signatureStamps, cb){

	if (signatureStamps.length === 0) {
		return cb(null, xfdf);
	} else {
		let newXfdfFile = xfdf.replace('.pdf', 's.pdf');
		// pdftk original.pdf multistamp multistamp.pdf output final.pdf
		let pdfStampProcess = spawn('pdftk', [ xfdf, 'multistamp', signatureStamps[0], 'output', newXfdfFile]);
		pdfStampProcess.stdout.on('data', (data) => {
			console.log(`pdfstamp stdout:\n${data.toString()}`);
		});
		pdfStampProcess.stderr.on('data', (data) => {
			console.log(`pdfstamp error:\n${data.toString()}`);
			return cb(data);
		});
		pdfStampProcess.on('close', (code, signal) => {
			console.log(`pdfstamp exit with:\n${code} ${signal}`);
			if (code !== 0){
				console.log(`pdfstamp error with:\n${code} ${signal}`)
			} else {
				// delete old xfdf file
				fs.unlink(xfdf, (err) => console.error(err));
				signatureStamps.shift();
				return addAllSignatures(newXfdfFile, signatureStamps, cb);
			}
		});		
	}
}

/* ####### DATAURL -> PNG -> SIGNATURE PDF FUNCTIONALITY #########
	- Convert DataUrl to Png
	- Convert Png to Positioned png.pdf
	- add blank pages around signature 
	- Resolve(//array of pdfs to be stamped ) */
function writeSignaturesToPdf(form, doc, signatures) {
	return new Promise( (resolve, reject) => {
		let tempImageFiles = [];
		let filesNeeded = Object.keys(signatures).length
		
		convertDataurlToPng(doc, signatures)
		.then(signaturesWithPngs => {
			return convertPngsToPdfs(signaturesWithPngs);
		})
		.then(signaturesWithPdfs => {
			return convertpdfsToA4PaperStamp(signaturesWithPdfs);
		})
		.then(signaturesWithStamps => {
			return addBlankPagesToStamps(form, signaturesWithStamps);
		})
		.then(signaturesWithStampsWithBlanks => {
			return resolve(signaturesWithStampsWithBlanks);
		})
		.catch(err => {
			return reject(err);
		});
	
	});
}

// convert obj of dataurl to array of png filepaths
function convertDataurlToPng(doc, signatures) {
	return new Promise( (resolve, reject) => {
		let imagesBuilt = 0;
		let filesNeeded = Object.keys(signatures).length
		for (let x in signatures) {
			// Build PNG files for data/url signatures
			let data = signatures[x].data.replace(/^data:image\/\w+;base64,/, "");
			let imgBuffer = new Buffer(data, 'base64');
			let tempImageFilePath = `temp/${doc._id}_${x}.png`;
			savePngFile(imgBuffer, tempImageFilePath, x, (err, file, key) => {
				if (err) {
					return reject(err);
				} else {
					signatures[key].pngFile = file;
					if (++imagesBuilt === filesNeeded) {
						return resolve(signatures);
					}
				}
			});
		}
	});
}
function savePngFile(data, filepath, key, cb){
	fs.writeFile(filepath, data, (err) => {
		if (err) {
			return cb(err);
		} else {
			return cb(null, filepath, key);
		}
	});
}

// convert array of png filepaths to pdf, return array of pdf filepaths 
function convertPngsToPdfs(signatures) {
	return new Promise( (resolve, reject) => {
		let filesNeeded = Object.keys(signatures).length
	  let pdfFilesBuilt = 0;
		for (let x in signatures) {
	    savePdfFile(signatures[x], x, (err, file, key) => {
	    	if (err) {
	    		return reject(err);
	    	} else {
	    		signatures[key].pdfFile = file;
	    		if (++pdfFilesBuilt === filesNeeded) {
	    			return resolve(signatures);
	    		}
	    	}
	    });
		}
	});
}
function savePdfFile(signature, key, cb){
  // Use Node-Canvas png->canvas->pdf
  fs.readFile(signature.pngFile, (err, file) => {
  	let pdfFilePath = signature.pngFile.replace('png', 'pdf');
  	let img = new Image;
  	img.src = file;
  	let canvas = new Canvas(img.width, img.height, 'pdf');
  	let ctx = canvas.getContext('2d');
  	ctx.drawImage(img, 0, 0, img.width, img.height)
		fs.writeFile(pdfFilePath, canvas.toBuffer(), (err) => {
  		if (err) {
  			console.log('convert png to pdf err', err);
  			return cb(err);
  		} else {
  			return cb(null, pdfFilePath, key);
  		}
  	});  	
  });
 /* loadImage(signature.pngFile)
  .then(img => {
    let pdfFilePath = img.src.replace('png', 'pdf');
  	let canvas = createCanvas(img.width, img.height, 'pdf');
  	let ctx = canvas.getContext('2d');
  	// ctx.addPage() can add pages to pdf
  	ctx.drawImage(img, 0, 0, img.width, img.height)
  	fs.writeFile(pdfFilePath, canvas.toBuffer(), (err) => {
  		if (err) {
  			console.log('convert png to pdf err', err);
  			return cb(err);
  		} else {
  			return cb(null, pdfFilePath, key);
  		}
  	});
  });*/
}


/* Create Stamp for each signature*/
function convertpdfsToA4PaperStamp(signatures) {
	return new Promise( (resolve, reject) => {
		let filesNeeded = Object.keys(signatures).length
		let stampsBuilt = 0;
		for (let x in signatures) {
			let signatureFile = signatures[x].pdfFile;
			let scale = 0.3;
			let offset = signatures[x].offsetX + ' ' + signatures[x].offsetY;
			let outputFile = signatureFile.replace('.pdf', '_stamp.pdf');
			pdfJamProcess(signatureFile, scale, offset, outputFile, x, (err, file, key) => {
				if (err) {
					return reject(err);
				}
				signatures[key].stampFile = file;
				if (++stampsBuilt === filesNeeded) {
					return resolve(signatures);
				}
			});
		}	
	});
}
function pdfJamProcess(signatureFile, scale, offset, outputFile, key, cb) {
	let pdfjamProcess = spawn('pdfjam', ['--paper', 'a4paper', '--scale', scale, '--offset', offset, '--outfile', outputFile, signatureFile]);
	pdfjamProcess.stdout.on('data', (data) => {
		console.log(`pdfjam stdout:\n${data.toString()}`);
	});
	pdfjamProcess.stderr.on('data', (data) => {
		console.log(`pdfjam error:\n${data.toString()}`);
	//	return reject(data);
	});
	pdfjamProcess.on('close', (code, signal) => {
		console.log(`pdfjam exit with:\n${code} ${signal}`);
		cb(null, outputFile, key);
	});
}

/* Wrap each stamp in blank pages to match pdf size */
function addBlankPagesToStamps(form, signatures) {
	return new Promise( (resolve, reject) => {
		let filesNeeded = Object.keys(signatures).length;
		let stampsFinished = 0;
		for (let x in signatures) {
			let pdfStampFile = signatures[x].stampFile;
			addBlankPages(pdfStampFile, form.pages, signatures[x].page, x, (err, file, key) => {
				if (err){
					return resolve(err);
				} else {
					signatures[key].finalStampFile = file;
					if (++stampsFinished === filesNeeded) {
						return resolve(signatures);
					}
				}
			});
		}
	});
}
function addBlankPages(stampFile, totalPages, page, key, cb) {
	const blankPageFile = 'public/uploads/blank.pdf';
	const outputFile = stampFile.replace('.pdf', '_blanks.pdf');
	// pagePattern = ['A1','B1', 'B1'] B1 - blank page, A1 - stamp
	// initialize pattern with all blank pages
	let pagePattern = Array.apply(null, {length:totalPages}).map(() => 'B1');
	pagePattern[page] = 'A1';
	
	// pdftk A=stamp.pdf B=blank.pdf cat B1 A1 B1 B1 output ____.pdf
	let pdftkParams = ['A='+stampFile, 'B='+blankPageFile, 'cat'].concat(pagePattern);
	pdftkParams.push('output');
	pdftkParams.push(outputFile);

	let pdftkProcess = spawn('pdftk', pdftkParams);
	pdftkProcess.stdout.on('data', (data) => {
	  console.log(`pdftk stamp stdout:\n${data.toString()}`);
	});
	pdftkProcess.stderr.on('data', (data) => {
		console.log(`pdftk stamp error:\n${data.toString()}`);
		return cb(data.toString());
	});
	pdftkProcess.on('close', (code, signal) => {
		console.log(`pdftk stamp exit with:\n${code} ${signal}`);
		cb(null, outputFile, key);
	});	
}
/* 	
		############ JSON -> XFDF -> PDF FUNCTIONALITY #############
 		write checkbox/text data to pdf
 		There will only be one xfdf file for each PDF
*/
function writeXfdfToPdf(form, doc, json) {
	return new Promise( (resolve, reject) => {
		xfdfBuild.fromJSON(json);
		let xfdfData = xfdfBuild.generateToFile(`temp/${doc._id}.xfdf`, (err, success) => {
			
			let xfdfLocation = `temp/${doc._id}.xfdf`;
			let originalFormLocation = form.pdf;
			let writeLocation = `${uploadPath}/${doc.owner}/${doc._id}.pdf`;
			
			//pdftk <input PDF form> fill_form <input FDF data> output <output PDF file> [flatten]
			let pdftkProcess = spawn('pdftk', ['./'+originalFormLocation, 'fill_form', xfdfLocation, 'output', writeLocation, 'flatten']);
			pdftkProcess.stdout.on('data', (data) => {
			  console.log(`pdftk stdout:\n${data.toString()}`);
			});
			pdftkProcess.stderr.on('data', (data) => {
				console.log(`pdftk error:\n${data.toString()}`);
				return reject(data);
			});
			pdftkProcess.on('close', (code, signal) => {
				console.log(`pdftk exit with:\n${code} ${signal}`);
				return resolve(writeLocation);
			});
		});
	});
}
// delete temp files used to stamp pdf
function cleanupTempFiles(xfdf, signatures) {
	fs.unlink(xfdf, err => { console.log(err) });
	for (let x in signatures) {
		fs.unlink(signatures[x].finalStampFile, err => {if(err)console.log('err deleting finalstampFile', x)});
		fs.unlink(signatures[x].pdfFile, err => {if(err)console.log('err deleting pdfFile', x)});
		fs.unlink(signatures[x].pngFile, err => {if(err)console.log('err deleting pngFile', x)});
		fs.unlink(signatures[x].stampFile, err => {if(err)console.log('err deleting stampFile', x)});
	}
}
//pdfjam --paper 'a4paper' --scale 0.5 --offset '+2cm +2cm' --outfile  temp/ temp/5aa9c025a017db23ec77cbfa_signature_owner.pdf 
//pdftk public/uploads/erd/erd.pdf stamp /Users/ericmcelyea/Documents/union5/public/uploads/Erd/5aa9c025a017db23ec77cbfa_signature_owner-pdfjam.pdf output final.pdf
