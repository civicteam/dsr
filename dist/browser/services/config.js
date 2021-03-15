const path=require("path"),os=require("os"),fs=require("fs"),isBrowser="undefined"!=typeof window&&"undefined"!=typeof window.document;if("win32"===process.platform)throw new Error(`Unsupported platform: ${process.platform}`);if("browser"!==process.env.APP_ENV&&!isBrowser){const a={BOX:"/etc/civic",USER:path.join(`${os.homedir()}`,".civic")},b=path.join(a.USER,"config"),c=path.join(a.BOX,"config"),d=fs.existsSync(b)?b:c;fs.existsSync(b)&&require("dotenv").config({path:d})}const config={partner:{id:process.env.PARTNER_ID,signingKeys:{xpub:process.env.PARTNER_XPUB,xprv:process.env.PARTNER_XPRV}},app:{id:process.env.APP_ID,name:process.env.APP_NAME,logo:process.env.APP_LOGO_URL,description:process.env.APP_DESCRIPTION,primaryColor:process.env.APP_PRIMARY_COLOR?process.env.APP_PRIMARY_COLOR:"A80B00",secondaryColor:process.env.APP_SECONDARY_COLOR?process.env.APP_SECONDARY_COLOR:"FFFFFF"},channels:{baseEventsURL:process.env.BASE_EVENT_URL,basePayloadURL:process.env.BASE_PAYLOAD_URL}};module.exports=config;