import config from "@config"

import db from "@db"
import { Storage } from "@google-cloud/storage"
import { EMediaType } from "@models/media/IMedia"
import { generateLimitedGuid, isTestENV } from "@service/common.helper"
import { getNested } from "@service/utils"
import axios, { AxiosResponse } from "axios"
import { createWriteStream, stat, Stats } from "fs"
import https from "https"
import { basename, extname, resolve } from "path"
import { Op } from "sequelize"
import sharp from "sharp"
import { Duplex, PassThrough, Stream } from "stream"
import { promisify } from "util"
import crypto = require("crypto");
import archiver = require("archiver");
import extractFrames = require("ffmpeg-extract-frames");
import FFMpeg = require("fluent-ffmpeg");
import gifify = require("gifify");
import request = require("request");
import genThumbnail = require("simple-thumbnail");
import { HttpRequestError } from "@service/errors"
import { createReadStream, existsSync } from "fs"

const PDFDocument = require("pdfkit")
const Jimp = require("jimp")
const mime = require("mime-types")

const fs = require("fs").promises

export enum EFileLocation {
  LOCAL = "local",
  REMOTE = "remote",
}

export interface IFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  destination: string;
  filename: string;
  path?: string;
  size: number;
  buffer: Buffer;
}

interface IMetadata {
  createdAt: any;
}

export interface IUnrecognizedFile extends IFile {
  data?: any;
  media_id?: number;
  type?: any;
  original?: string;
  buffer: Buffer;
  filename: string;
}

export interface IFileTypes {
  small?: string;
  medium?: string;
  compressed?: string;
  data?: any;
  media_id?: number;
  original: string;
  createdAt?: Date;
  filename?: string;
  interactive?: string;
  preview?: string;
  gif?: string;
  size?: number;
  type?: string;
}

export interface IUploadOptions {
  isDisableGenerateName?: boolean;
}

export interface IConvertOptions {
  maxFrames?: number;
  frameName?: string;
}

export const readdir = promisify(fs.readdir)

export enum TransformFileTypes {
  PDF = "pdf",
  PNG = "png",
  JPG = "jpg"
}

export default class StorageService extends Storage {
  public static tmpDir = "./tmp"
  public uploadedFiles = []

  private defaultUploadOptions = Object.freeze({
    gzip: true,
    metadata: {
      cacheControl: "public, max-age=31536000"
    }
  })

  constructor(readonly destination: string, private files?: IFile[], private types: string[] = []) {
    super()
  }

  static filename(file: IFile, salt?: string, mimeType: string = null): string {
    return this.generateFileName(file.originalname, mimeType || file.mimetype, salt)
  }

  static async isFileExists(filePath: string): Promise<boolean> {
    return fs.stat(filePath).then(() => true).catch(() => false)
  }

  static isImage(file: IFileTypes | IFile): boolean {
    if ((file as IFile).mimetype) {
      return (file as IFile).mimetype.startsWith("image")
    } else {
      return [EMediaType.image, EMediaType.blink].includes((file as IFileTypes).type as EMediaType)
    }
  }

  static isVideo(file: IFileTypes | IFile): boolean {
    if ((file as IFile).mimetype) {
      return (file as IFile).mimetype.startsWith("video")
    } else {
      return [EMediaType.video, EMediaType.video360].includes((file as IFileTypes).type as EMediaType)
    }
  }

  static getname = (url: string, typeOrExt = "") => `${basename(url, extname(url))}${typeOrExt}`

  static async unlink(...paths: string[]) {
    return Promise.all(paths.map((path) => fs.unlink(path)))
  }

  static async createPath(path: string): Promise<void> {
    return await fs.mkdir(path, { recursive: true })
  }

  static async uploadFilesFromBuffer(user_id: number, process: string, files: Buffer[], originalFiles: IUnrecognizedFile[]): Promise<[string[], string[]]> {
    const destination = `background_images/${process}/${user_id}`
    const storage = new Storage()
    const bucket = storage.bucket(config.bucket_name)

    const filesToUpload = files.map((buffer, index) => ({
      buffer,
      filename: generateLimitedGuid() + (originalFiles[index].filename || originalFiles[index].originalname)
    }))

    await Promise.all(filesToUpload.map(async ({ buffer, filename }) => {
      await Promise.all([
        bucket.file(`${destination}/${this.getname(filename, ".png")}`).save(buffer, {
          metadata: { cacheControl: "public, max-age=31536000" },
          contentType: "image/png",
        }),
        bucket.file(`${destination}/${this.getname(this.getname(filename) + "_preview", ".jpg")}`).save(
          await sharp(buffer).resize(640).toBuffer(), {
            metadata: { cacheControl: "public, max-age=31536000" },
            contentType: "image/jpg",
          })
      ])
    }))
    return [
      [...filesToUpload.map(({ filename }) => `${config.hosts.static}/${destination}/${this.getname(filename, ".png")}`)],
      [...filesToUpload.map(({ filename }) => `${config.hosts.static}/${destination}/${this.getname(this.getname(filename) + "_preview", ".jpg")}`)]
    ]
  }

  async uploadAsJson(data: any, filename: string) {
    return this.bucket(config.bucket_name)
      .file(`${this.destination}${filename}`)
      .save(JSON.stringify(data), {
        gzip: true,
        metadata: { cacheControl: "public, max-age=31536000" },
        contentType: "application/json",
      })
  }

  public static generateFileName(originalName: string, mimeType: string, salt: string = "") {
    const randomKey = crypto.randomBytes(10).toString("hex")
    const replacedName = originalName.replace(/\.png|\.jpg|\.jpeg|\.gif|\.pdf|\.xls|\.xlsx|\.csv|\W*/g, "")
    return `${Date.now()}-${randomKey}-${replacedName}${salt}.${mime.extension(mimeType)}`
  }

  public getFileName = (url: string, typeOrExt = "") => `${basename(url, extname(url))}${typeOrExt}`

  public buildFileUrl = (filename): string => `${config.hosts.static}/${this.destination}/${filename}`

  public removeEntity = async (destination = this.destination) => this.bucket(config.bucket_name).deleteFiles({
    prefix: destination
  })

  public async removeFile(fileUrl: string): Promise<any[]> {
    return this.bucket(config.bucket_name)
      .file(`${this.destination}/${this.getFileName(fileUrl, extname(fileUrl))}`)
      .delete()
  }

  public async removeMediaFile(file: IFileTypes): Promise<any[]> {
    if (!file) return null

    return Promise.all(
      Object.values(file).map((fileName) => {
        if (fileName)
          this.bucket(config.bucket_name)
            .file(`${this.destination}/${this.getFileName(fileName, extname(fileName))}`)
            .delete()
      })
    )
  }

  public async uploadVideo(file: IFile, index: number): Promise<IFileTypes> {
    if (!file) return null
    const isWebmFile = file.mimetype.includes("webm")

    const filename = StorageService.filename(file)
    const smallFileName = this.getFileName(filename, "small") + ".jpeg"
    const previewFileName = this.getFileName(filename, "preview") + ".jpg"
    const input = StorageService.tmpDir + `/${filename}`
    const tempFile = StorageService.tmpDir + `/temp_${StorageService.filename(file)}`
    let compressedFileName = this.getFileName(filename, "compressed") + ".mp4"

    if (isWebmFile) compressedFileName = filename

    try {
      await fs.writeFile(input, Buffer.from(file.buffer))

      await this.rePackageVideo(input, tempFile)

      const handles = [
        this.uploadStreamToStorage(`${this.destination}/${smallFileName}`, await this.getVideoThumbnail(input), "image/jpeg"),
        this.uploadStreamToStorage(`${this.destination}/${previewFileName}`, await this.getVideoThumbnailWithOverlay(input), "image/jpeg")
      ]

      if (existsSync(tempFile)) {
        const tempfileStream = createReadStream(tempFile)
        handles.push(this.uploadStreamToStorage(`${this.destination}/${filename}`, tempfileStream, "application/octet-stream"))
      } else {
        handles.push(this.uploadFileToStorage(`${this.destination}/${filename}`, file, "application/octet-stream"))
      }

      if (!isWebmFile) {
        handles.push(new Promise((res, rej) => {
          const outputCompressedVideo = this.createWriteBucket(`${this.destination}/${compressedFileName}`, file.mimetype)
          this.compressVideo(input, outputCompressedVideo, res, rej)
        }))
      }

      await Promise.all(handles)

      const metadata = await this.getMetadata(file)
      await fs.unlink(input)
      if (existsSync(tempFile)) {
        await fs.unlink(tempFile)
      }

      return {
        original: this.buildFileUrl(filename),
        createdAt: metadata.createdAt,
        small: this.buildFileUrl(smallFileName),
        medium: this.buildFileUrl(compressedFileName),
        compressed: this.buildFileUrl(compressedFileName),
        preview: this.buildFileUrl(previewFileName),
        interactive: this.types[index] === EMediaType.video360 && file.mimetype.includes("video") ? "true" : null,
        filename: file.originalname,
        size: file.size
      }
    } catch (err) {
      await fs.unlink(input)
      if (existsSync(tempFile)) {
        await fs.unlink(tempFile)
      }
      throw err
    }
  }

  static async getFramesFromVideo(file: IUnrecognizedFile): Promise<[IFile[], string]> {
    const process = generateLimitedGuid()
    const path = StorageService.tmpDir + `/${process}`
    const input = `${path}/${file.filename || file.originalname}`

    if (!file.buffer) file = await axios.get(file.original, { responseType: "arraybuffer" })

    await this.createPath(StorageService.tmpDir + `/${process}`)
    await fs.writeFile(input, file.buffer || Buffer.from(file.data))

    const metadata = await StorageService.getVideoMetadata(input)
    let numFrames = getNested(metadata, "streams", 0, "nb_frames")

    if (!numFrames || numFrames === "N/A")
      throw new HttpRequestError(400, "Background already removed", "bg:removed")

    numFrames = numFrames ? (numFrames > 160 ? 160 : numFrames) : 36

    await extractFrames({ input, output: `${path}/%3d.jpg`, numFrames })

    await fs.unlink(input)

    const frames = await fs.readdir(path)
    return [
      await Promise.all(frames.map(frame => fs.readFile(path + `/${frame}`))),
      process
    ]
  }

  static async makeVideoFromFrames(process: string, images: Buffer[], file: IUnrecognizedFile, type?: string): Promise<[string, string]> {
    const path = StorageService.tmpDir + `/${process}/video_frames`
    const storage = new Storage()
    const bucket = storage.bucket(config.bucket_name)

    const format = type === "transparent" ? "png" : "jpg"
    const formatVideo = type === "transparent" ? "webm" : "mp4"

    await this.createPath(path)

    await Promise.all(images.map((image, index) => fs.writeFile(path + `/${index}.${format}`, image)))

    const outputCompressedVideo = await StorageService.createWriteBucket(
      `background_images/${process}/${StorageService.getname(file.filename || file.originalname, `.${formatVideo}`)}`, `video/${formatVideo}`
    )

    const preview = await fs.readFile(path + `/0.${format}`)
    await bucket.file(`background_images/${process}/${this.getname(file.filename || file.originalname) + "_preview.jpg"}`).save(preview, {
      metadata: { cacheControl: "public, max-age=31536000" },
      contentType: "image/jpg",
    })

    if (formatVideo === "webm") {
      await new Promise((res, rej) => {
        new FFMpeg(path + `/%d.${format}`)
          .inputOptions([`-framerate ${Math.floor(images.length / 9)}`])
          .addOptions(["-t 10", "-pix_fmt yuva420p"])
          .format("webm")
          .on("error", rej)
          .on("end", res)
          .pipe(outputCompressedVideo)
      })
    } else {
      await new Promise((res, rej) => {
        new FFMpeg(path + `/%d.${format}`)
          .inputOptions([`-framerate ${Math.floor(images.length / 9)}`])
          .addOptions(["-t 10", "-pattern_type glob", "-c:v libx264", "-pix_fmt yuva420p"])
          .format("mp4")
          .addOptions(["-movflags empty_moov"])
          .on("error", rej)
          .on("end", res)
          .pipe(outputCompressedVideo)
      })
    }

    return [
      `${config.hosts.static}/background_images/${process}/${this.getname(file.filename || file.originalname) + "_preview.jpg"}`,
      `${config.hosts.static}/background_images/${process}/${StorageService.getname(file.filename || file.originalname, `.${formatVideo}`)}`
    ]
  }

  private static async resizeArchive(size: any, format: string, files: any[], stream: Duplex): Promise<void> {
    const archive = archiver("zip", { zlib: { level: 9 } })
    const handledMedia = []
    const fileNames = files.map(file => {
      if (!file.product) {
        return null
      }

      handledMedia.push(file.product)

      const mediaNameQuantity = handledMedia.filter((item) => file.product._id === item._id).length

      return `${file.product.sku || file.product.title}_${mediaNameQuantity}`
    })

    await Promise.all(files.map(async (file, index) => {
      return new Promise(async (resolve) => {
        await request.head(file.original, async function (err, res, body) {
          const defaultFilename = `${file.filename ? file.filename.replace(/\.[^/.]+$/, "") : "unnamed"}-${index}`

          const filename = fileNames[index] || defaultFilename

          if (StorageService.isImage(file)) {
            const metadata = await request(file.original).pipe(sharp()).metadata()
            const width = size.width || metadata.width
            const height = size.height || metadata.height
            const isTheSameFileExtension = ((format === metadata.format && format !== "jpg") || ["jpg", "jpeg"].includes(metadata.format))
            const isOriginalPicture = (
              (
                (!size.width && !size.height) ||
                (Number(size.width) === metadata.width && Number(size.height) === metadata.height)
              ) &&
              isTheSameFileExtension
            )

            if (isOriginalPicture) {
              archive.append(request(file.original),
                { name: `${filename}.${format}` }
              )
            } else {
              archive.append(request(file.original).pipe(
                sharp().toFormat(format).resize(Number(width), Number(height))
              ),
              { name: `${filename}.${format}` }
              )
            }
          } else {
            const separatedName = file.filename.split(".")
            const fileExtension = separatedName[separatedName.length - 1]

            archive.append(request(file.original), { name: `${filename}.${fileExtension}` })
          }
          resolve()
        })
      })
    }))

    archive.pipe(stream)

    archive.finalize()
  }

  private static async resizePDF(size: any, format: string, files: any[], stream: Duplex): Promise<void> {
    const isVideoIncludes = !!files.filter(StorageService.isVideo).length

    const doc = new PDFDocument()
    const archive = archiver("zip", { zlib: { level: 9 } })

    const images = await Promise.all(files.filter(StorageService.isImage).map(async (file, index) => {
      const image = await axios.get(file.original, {
        responseType: "arraybuffer"
      })
      return image.data
    }))

    images.map((image, index) => {
      if (index === 0) {
        doc.image(image, {
          fit: [480, 480],
          align: "center",
          valign: "center"
        })
      } else {
        doc.addPage().image(image, {
          fit: [480, 480],
          align: "center",
          valign: "center"
        })
      }
    })

    if (isVideoIncludes) {
      archive.append(doc, { name: "medias.pdf" })
      archive.pipe(stream)
      await Promise.all(files.filter(StorageService.isVideo).map(async (file, index) => {
        return new Promise(async (resolve) => {
          await request.head(file.original, async function (err, res, body) {
            archive.append(request(file.original), { name: file.filename })
            resolve()
          })
        })
      }))
      archive.finalize()
    } else {
      doc.pipe(stream)
    }

    doc.save()
    doc.end()
  }

  public static async resize(size: any, format: string, files: any[]): Promise<Duplex> {
    const stream = new Stream.PassThrough()

    if (files.length === 1 && (format !== "pdf" || (format === "pdf" || (format === "pdf" && files.filter(StorageService.isVideo).length)))) {
      const file = files[0]
      request.head(encodeURIComponent(file.original), function (err, res, body) {
        if (StorageService.isImage(file)) {
          request(encodeURI(file.original)).pipe(sharp()).metadata().then(metadata => {
            const width = size.width || metadata.width
            const height = size.height || metadata.height
            const isTheSameFileExtension = ((format === metadata.format && format !== "jpg") || ["jpg", "jpeg"].includes(metadata.format))
            const isOriginalPicture = (
              (
                (!size.width && !size.height) ||
                (Number(size.width) === metadata.width && Number(size.height) === metadata.height)
              ) &&
              isTheSameFileExtension
            )

            if (isOriginalPicture) {
              request(encodeURI(file.original)).pipe(stream)
              return
            }

            request(encodeURI(file.original))
              .pipe(sharp().withMetadata({
                density: metadata.density,
              }).toFormat(format).resize(Number(width), Number(height)))
              .pipe(stream)
          })
        } else {
          request(encodeURI(file.original)).pipe(stream)
        }
      })
      return stream
    }

    if (format !== "pdf") await StorageService.resizeArchive(size, format, files, stream)
    else await StorageService.resizePDF(size, format, files, stream)

    return stream
  }

  public async uploadPdf(file: IFile) {
    if (!file) return null
    const filename = StorageService.filename(file)

    await this.uploadFileToStorage(`${this.destination}/${filename}`, file, "application/pdf", false)

    const metadata = await this.getMetadata(file)
    const fileUrl = this.buildFileUrl(filename)

    return {
      original: fileUrl,
      small: fileUrl,
      medium: fileUrl,
      createdAt: metadata.createdAt,
      // createdAt: null,
      filename: file.originalname,
      size: file.size
    }
  }

  public async uploadImage(file: IFile): Promise<IFileTypes> {
    if (!file) return null
    const filename = StorageService.filename(file)

    const smallFileName = this.getFileName(filename, "small") + extname(filename)
    const mediumFileName = this.getFileName(filename, "medium") + extname(filename)

    const format = (extname(filename).toLowerCase().includes("png")) ? "png" : "jpg"

    const sharpForOriginal = file.size > 10000 * 1024 && sharp().toFormat(format).resize(2600)

    await Promise.all([
      this.uploadFileToStorage(`${this.destination}/${filename}`, file, "application/octet-stream", false),
      this.uploadFileToStorage(`${this.destination}/${mediumFileName}`, file, null, sharpForOriginal),
      this.uploadFileToStorage(`${this.destination}/${smallFileName}`, file, null, sharp().toFormat(format).resize(320))
    ])

    const metadata = await this.getMetadata(file)

    return {
      original: this.buildFileUrl(filename),
      small: this.buildFileUrl(smallFileName),
      medium: this.buildFileUrl(mediumFileName),
      createdAt: metadata.createdAt,
      // createdAt: null,
      filename: file.originalname,
      size: file.size
    }
  }

  public async rollback() {
    if (!this.uploadedFiles.length) return null

    try {
      await Promise.all(
        this.uploadedFiles.map((fileName) => {

          if (fileName)
            return this.bucket(config.bucket_name)
              .file(`${this.destination}/${this.getFileName(fileName, extname(fileName))}`)
              .delete()
        })
      )
    } catch (err) { }
  }

  public static async compressVideoStreamAndSaveToFile(input: string, output: string): Promise<string> {
    await new Promise((res, rej) => {
      FFMpeg(input)
        .size("1440x?")
        .addOptions(["-preset slow", "-crf 28", "-x264-params keyint=1"])
        .addOutputOption("-movflags", "frag_keyframe+empty_moov")
        .format("mp4")
        .on("error", rej)
        .on("end", res)
        .save(output)
    })

    return output
  }

  private compressVideo(input: string | Stream, output: Stream, res: Function, rej: Function) {
    new FFMpeg(input)
      .size("1080x?")
      .addOptions(["-preset ultrafast", "-r 30", "-crf 24", "-x264-params keyint=2"])
      .format("mp4")
      .addOptions(["-movflags empty_moov"])
      .on("error", rej)
      .on("end", () => {
        console.timeEnd("compress")
        res()
      })
      .pipe(output)
  }

  public static async convertUrlVideoToGif(sourceUrl: string, output: Stream, gifOptions = {}) {
    return await new Promise((resolve, reject) => {
      https.get(sourceUrl, function (res) {
        const stream = new PassThrough()
        stream.on("error", reject)
        res.pipe(stream, { end: true })

        output.on("finish", resolve)
        output.on("error", reject)

        StorageService.getGifFromVideo(stream, output, () => { }, reject, gifOptions)
      })
    })
  }

  public static getGifFromVideo(input: string | Stream, output: Stream, res: Function = () => { }, rej: Function = () => { }, gifOptions: {} = {}) {
    gifify(input, {
      resize: "360:-1",
      to: "00:00:30",
      ...gifOptions
    })
      .on("end", res)
      .on("error", rej)
      .pipe(output, { end: true })
  }

  public static getThumbnailFromVideo(input: string | Stream, output: Stream, res: Function, rej: Function) {
    new FFMpeg(input)
      .format("image2")
      .screenshots({ timestamps: [0.0] })
      .on("error", rej)
      .on("end", res)
      .pipe(output, { end: true })
  }

  private createGzipWriteBucket(destination, type?: string) {
    this.uploadedFiles.push(destination)
    const uploadFile = this.bucket(config.bucket_name).file(destination)
    return uploadFile.createWriteStream({
      gzip: true,
      metadata: { cacheControl: "public, max-age=31536000" },
      contentType: type,
      resumable: false
    })
  }

  private createWriteBucket(destination, type?: string) {
    this.uploadedFiles.push(destination)
    const uploadFile = this.bucket(config.bucket_name).file(destination)
    return uploadFile.createWriteStream({
      metadata: { cacheControl: "public, max-age=31536000" },
      contentType: type,
      resumable: false
    })
  }

  static async createWriteBucket(destination, type?: string) {
    const storage = new Storage()
    const file = storage.bucket(config.bucket_name).file(destination)
    return file.createWriteStream({
      metadata: { cacheControl: "public, max-age=31536000" },
      contentType: type,
      resumable: false
    })
  }

  public async uploadFileToStorage(destination, file: IFile, type?: string, transformer?: any, isCompression = true): Promise<any> {
    const readableStream = new PassThrough()
    const buffer = Buffer.from(file.buffer)
    readableStream.end(buffer)
    return this.uploadStreamToStorage(destination, readableStream, type || file.mimetype, transformer, isCompression)
  }

  public async uploadStreamToStorage(destination: string, readableStream: Stream, mimetype: string, transformer?: any, isCompression = true) {
    return new Promise((res, rej) => {
      if (isTestENV()) return res()
      const writeStream = isCompression ? this.createGzipWriteBucket(destination, mimetype) : this.createWriteBucket(destination, mimetype)
      if (transformer) {
        readableStream.pipe(transformer).on("error", rej).pipe(writeStream)
      } else {
        readableStream.pipe(writeStream)
      }
      writeStream.on("error", rej)
      writeStream.on("finish", res)
    })
  }

  public async uploadAnyFile(options: IUploadOptions = {}): Promise<string> {
    const filename = options.isDisableGenerateName ? this.files[0].originalname : StorageService.filename(this.files[0])

    await this.uploadFileToStorage(`${this.destination}/${filename}`, this.files[0], "application/octet-stream")

    return this.buildFileUrl(filename)
  }

  public async uploadAnyFiles(options: IUploadOptions = {}): Promise<string[]> {
    return Promise.all(this.files.map(async file => {
      const filename = options.isDisableGenerateName ? file.originalname : StorageService.filename(this.files[0])

      await this.uploadFileToStorage(`${this.destination}/${filename}`, file, "application/octet-stream")

      return this.buildFileUrl(filename)
    }))
  }

  public async uploadTextFile(): Promise<string> {
    const filename = StorageService.filename(this.files[0])

    await this.uploadFileToStorage(`${this.destination}/${filename}`, this.files[0], "application/octet-stream")

    return this.buildFileUrl(filename)
  }

  public async uploadFiles(): Promise<IFileTypes[]> {
    if (!this.files) return
    return Promise.all(
      this.files.map((file, index) => {
        if (file.mimetype.includes("video")) {
          return this.uploadVideo(file, index)
        } else {
          return this.uploadImage(file)
        }
      })
    )
  }

  get getFiles() {
    return this.files
  }

  public async getBufferFromStream(rs: PassThrough): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const buffers = []
      rs.on("data", (d) => buffers.push(d))
      rs.on("error", (e) => reject(e))
      rs.on("end", () => resolve(Buffer.concat(buffers)))
    })
  }

  public async getVideoThumbnail(videoSrc: string): Promise<PassThrough> {
    const stream = new PassThrough()
    await genThumbnail(videoSrc, stream, "640x?")
    return stream
  }

  // fix the problem of duration=N/A in the video stream which from windows.
  private async rePackageVideo(input: string | Stream, output: string) {
    return new Promise((res, rej) => {
      new FFMpeg(input)
        .outputOptions("-c", "copy")
        .output(output)
        .on("end", res)
        .on("error", (e) => {
          fs.unlink(output)
          rej(e)
        })
        .run()
    }).catch(err => {
      console.error("storage.service/rePackageVideo:", err)
    })
  }

  public async getVideoThumbnailWithOverlay(videoSrc: string): Promise<PassThrough> {
    const previewStream = await this.getVideoThumbnail(videoSrc)
    return await this.addOverlayToImage(await this.getBufferFromStream(previewStream))
  }

  public async addOverlayToImage(source: string | Buffer, overlaySrc = "static/play_240.png", maxWidth = 640, wmWidth = 240, wmHeight = 240): Promise<PassThrough> {
    let sourceImage = await Jimp.read(source)
    sourceImage = sourceImage.scaleToFit(maxWidth, Jimp.AUTO, Jimp.RESIZE_BEZIER)

    let watermark = await Jimp.read(overlaySrc)
    watermark = await watermark.resize(wmWidth, wmHeight)

    const wmPsnX = (Number(sourceImage.bitmap.width) / 2) - wmWidth / 2
    const wmPsnY = (Number(sourceImage.bitmap.height) / 2) - wmHeight / 2

    sourceImage.composite(watermark, wmPsnX, wmPsnY, {
      mode: Jimp.BLEND_SOURCE_OVER,
      opacityDest: 1,
      opacitySource: 0.9
    })

    const stream = new PassThrough()
    stream.end(await sourceImage.getBufferAsync(Jimp.MIME_JPEG))
    return stream
  }

  public static async deleteMedia(user_id: number, media_ids: number[] = [], isAll: boolean = false) {
    if (isAll) {
      return await new StorageService(`gallery/${user_id}`).removeEntity()
    } else {
      const medias = await db.Media.findAll({ where: { id: { [Op.in]: media_ids }, user_id } })
      return await Promise.all(
        medias.map(async ({ file: { original } }) => {
          await new StorageService(`gallery/${user_id}/${basename(original, extname(original))}`).removeEntity()
        })
      )
    }
  }

  public static readdirRecursive = async (dir): Promise<string[]> => {
    const dirents = await fs.readdir(dir, { withFileTypes: true })
    const files = await Promise.all(dirents.map((dirent) => {
      const res = resolve(dir, dirent.name)
      return dirent.isDirectory() ? StorageService.readdirRecursive(res) : res
    }))
    return Array.prototype.concat(...files)
  }

  public static async deleteDirectory(path: string): Promise<boolean> {
    try {
      await fs.rmdir(path, { recursive: true })
      return true
    } catch (e) {
      console.error(e)
      return false
    }
  }

  public static async getFileSize(fileSrc: string): Promise<number> {
    const stats: Stats = await new Promise((res, rej) => {
      stat(fileSrc, (err, stats) => {
        if (err) rej(err)
        else res(stats)
      })
    })
    return stats.size
  }

  public static async getMultipleFilesSize(filesSrc: Array<[string, EFileLocation]>): Promise<number> {
    const sizes = await Promise.all(filesSrc.map(([src, loc]) => (loc === EFileLocation.LOCAL) ? this.getFileSize(src) : this.getRemoteFileSize(src)))
    return sizes.reduce((sum, curr) => sum + curr, 0)
  }

  public static async getRemoteFileSize(remoteUrl: string): Promise<number> {
    const { headers } = await axios.head(remoteUrl)
    const size = (headers["content-length"]) ? headers["content-length"] : headers["x-goog-stored-content-length"]
    if (!size) throw new Error("Remote file size unknown")
    return Number(size)
  }

  public static async getFilesSize(filesSrc: Array<[string, EFileLocation]>): Promise<number> {
    const sizes = await Promise.all(filesSrc.map(([src, loc]) => (loc === EFileLocation.LOCAL) ? this.getFileSize(src) : this.getRemoteFileSize(src)))
    return sizes.reduce((sum, curr) => sum + curr, 0)
  }

  public static async getVideoMetadata(input: string) {
    return new Promise((res, rej) =>
      FFMpeg.ffprobe(input, function (err, metadata) {
        if (err) rej(err)
        res(metadata)
      })
    )
  }

  public static async convertVideoToFrames(inputPath: string, destPath: string, options?: IConvertOptions): Promise<[string, string[]]> {
    try {
      const { frameName = "frame_" } = options
      let { maxFrames } = options
      const framesDir = `${destPath}/frames`

      await StorageService.createPath(framesDir)

      if (!maxFrames) {
        const metadata = await StorageService.getVideoMetadata(inputPath)
        maxFrames = getNested(metadata, "streams", 0, "nb_frames")
        maxFrames = maxFrames ? (maxFrames > 240 ? 240 : maxFrames) : 36
      }

      await extractFrames({ input: inputPath, output: `${framesDir}/${frameName}%d.jpg`, numFrames: maxFrames })
      const frames: string[] = await fs.readdir(framesDir)

      return [framesDir, frames]
    } catch (err) {
      console.error(err)
      throw err
    }
  }

  public static async fetchRemoteFile(remoteUrl: string, destPath: string): Promise<string> {
    const output = createWriteStream(destPath)
    const response: AxiosResponse<Stream> = await axios.get(remoteUrl, { responseType: "stream" })

    await new Promise((resolve, reject) => {
      response.data.pipe(output)
      let error = null
      output.on("error", (e) => {
        error = e
        output.close()
        reject(e)
      })

      output.on("close", () => {
        if (!error) {
          resolve(true)
        }
      })
    })

    return destPath
  }

  // copy a file on bucket from remoteUrl to destRemoteUrl
  public static async copyRemoteFile(remoteUrl: string, destRemoteUrl: string): Promise<string> {
    try {
      const srcUrl = new URL(remoteUrl)
      const destUrl = new URL(destRemoteUrl)
      const srcFilename = srcUrl.pathname.replace("/", "")
      const desFilename = destUrl.pathname.replace("/", "")
      const storage = new Storage()
      const bucket = storage.bucket(config.bucket_name)
      await bucket.file(srcFilename).copy(desFilename)
      return destRemoteUrl
    } catch (e) {
      console.error(e)
      return ""
    }
  }

}